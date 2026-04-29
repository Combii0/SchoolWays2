import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import {
  getAdminAuth,
  getAdminDb,
  getAdminMessaging,
} from "../../../lib/firebaseAdmin";
import {
  isMonitorProfile,
  isStudentProfile,
} from "../../../lib/profileRoles";

export const runtime = "nodejs";

const EVENT_TYPES = {
  ETA_UPDATE: "eta_update",
  STOP_STATUS_UPDATE: "stop_status_update",
};

const STOP_STATUS = {
  BOARDED: "boarded",
  MISSED_BUS: "missed_bus",
};

const SERVICE_TIME_ZONE = "America/Bogota";

const toText = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().trim();
};

const toLowerText = (value) => toText(value).toLowerCase();

const normalizeKeyPart = (value) =>
  toText(value)
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/\s+/g, " ");

const normalizeStopKey = (stop) => {
  if (!stop || typeof stop !== "object") return "";
  const id = normalizeKeyPart(stop.id ?? stop.key);
  if (id) return id;
  const address = normalizeKeyPart(stop.address);
  if (address) return address;
  return normalizeKeyPart(stop.title);
};

const normalizeRouteId = (value) => {
  const routeText = toText(value);
  if (!routeText) return "";
  return routeText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

const normalizeMatchText = (value) => {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
};

const firstAddressSegment = (value) => toText(value).split(",")[0]?.trim() || "";

const getStudentDisplayName = (profile) => {
  const fallbackName = [toText(profile?.firstName), toText(profile?.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();
  const candidates = [
    profile?.studentName,
    profile?.displayName,
    profile?.fullName,
    profile?.name,
    fallbackName,
  ];
  const selected = candidates.map(toText).find(Boolean);
  return selected || "Estudiante";
};

const getServiceDateKey = (date = new Date()) => {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: SERVICE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch (error) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
};

const parseInteger = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
};

const parseNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const extractPushTokens = (profile) => {
  const tokens = [];
  const direct = profile?.pushNotifications?.web?.token;
  if (typeof direct === "string" && direct.trim()) {
    tokens.push(direct.trim());
  }

  const list = profile?.pushNotifications?.web?.tokens;
  if (Array.isArray(list)) {
    list.forEach((item) => {
      if (typeof item === "string" && item.trim()) {
        tokens.push(item.trim());
      }
    });
  }

  if (typeof profile?.fcmToken === "string" && profile.fcmToken.trim()) {
    tokens.push(profile.fcmToken.trim());
  }

  return [...new Set(tokens)];
};

const readBearerToken = (request) => {
  const raw = request.headers.get("authorization") || "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
};

const buildStateId = ({ dateKey, routeId, uid }) => {
  const safeDate = toText(dateKey).replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeRoute = normalizeRouteId(routeId || "route") || "route";
  const safeUid = toText(uid).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${safeDate}__${safeRoute}__${safeUid}`;
};

const isInvalidTokenCode = (code) => {
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
};

const enqueueInAppNotification = async ({ db, student, title, message }) => {
  if (!student?.uid || !message) return { delivered: false };
  const notificationId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await db
      .collection("users")
      .doc(student.uid)
      .set(
        {
          lastRouteNotification: {
            id: notificationId,
            title: title || "SchoolWays",
            body: message,
            kind: "student-route-update",
            routeId: student.routeId || null,
            createdAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    return { delivered: true };
  } catch (error) {
    return { delivered: false };
  }
};

const cleanupInvalidToken = async (db, uid, token) => {
  if (!uid || !token) return;
  const userRef = db.collection("users").doc(uid);
  const snapshot = await userRef.get();
  if (!snapshot.exists) return;
  const data = snapshot.data() || {};
  const storedToken = data?.pushNotifications?.web?.token;

  if (storedToken === token) {
    await userRef.set(
      {
        pushNotifications: {
          web: {
            token: FieldValue.delete(),
            enabled: false,
            updatedAt: FieldValue.serverTimestamp(),
          },
        },
      },
      { merge: true }
    );
    return;
  }

  const tokenList = Array.isArray(data?.pushNotifications?.web?.tokens)
    ? data.pushNotifications.web.tokens
    : [];
  if (!tokenList.length) return;
  const cleaned = tokenList.filter((item) => item !== token);
  await userRef.set(
    {
      pushNotifications: {
        web: {
          tokens: cleaned,
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
    },
    { merge: true }
  );
};

const sendPushMessage = async ({ messaging, db, student, title, message }) => {
  const tokens = extractPushTokens(student.profile);
  if (!tokens.length) {
    return { delivered: false, tokenCount: 0, reason: "no-token" };
  }

  const payload = {
    tokens,
    data: {
      title: title || "SchoolWays",
      body: message,
      routeId: student.routeId,
      kind: "student-route-update",
      at: Date.now().toString(),
      link: "/recorrido",
    },
    webpush: {
      headers: {
        Urgency: "high",
        TTL: "120",
      },
      notification: {
        title: title || "SchoolWays",
        body: message,
        icon: "/logo.png",
        badge: "/favicon.ico",
        tag: "schoolways-route-alert",
        image: "/icons/map.png",
        actions: [
          {
            action: "open-route",
            title: "Ver recorrido",
          },
        ],
      },
      fcmOptions: {
        link: "/recorrido",
      },
    },
  };

  let response;
  try {
    response = await messaging.sendEachForMulticast(payload);
  } catch (error) {
    return {
      delivered: false,
      tokenCount: tokens.length,
      reason: error?.code || "send-error",
    };
  }

  if (response.failureCount > 0) {
    await Promise.all(
      response.responses.map(async (item, index) => {
        if (item.success) return;
        const token = tokens[index];
        const code = item.error?.code || "";
        if (isInvalidTokenCode(code)) {
          await cleanupInvalidToken(db, student.uid, token);
        }
      })
    );
  }

  return {
    delivered: response.successCount > 0,
    tokenCount: tokens.length,
    reason:
      response.successCount > 0
        ? "sent"
        : response.responses.find((item) => !item.success)?.error?.code || "all-failed",
  };
};

const buildStops = (rawStops) => {
  if (!Array.isArray(rawStops)) return [];

  return rawStops
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const key = normalizeStopKey(item) || normalizeStopKey({ key: `paradero-${index + 1}` });
      if (!key) return null;

      const orderValue = parseInteger(item.order ?? item.sourceIndex);
      return {
        key,
        address: toText(item.address),
        title: toText(item.title) || `Paradero ${index + 1}`,
        order: orderValue !== null ? orderValue : index,
        minutes: parseInteger(item.minutes),
        distanceMeters: parseNumber(item.distanceMeters),
        status: toLowerText(item.status),
        excluded: Boolean(item.excluded),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
};

const findChangedStop = (changedStop, stops) => {
  if (!changedStop || typeof changedStop !== "object") return null;

  const key = normalizeStopKey(changedStop);
  const byKey = key ? stops.find((item) => item.key === key) : null;
  if (byKey) {
    return {
      ...byKey,
      status: toLowerText(changedStop.status) || byKey.status,
    };
  }

  const addressMatch = normalizeMatchText(changedStop.address);
  const titleMatch = normalizeMatchText(changedStop.title);
  return (
    stops.find((item) => {
      const stopAddress = normalizeMatchText(item.address);
      const stopTitle = normalizeMatchText(item.title);
      return (
        (addressMatch && stopAddress && addressMatch === stopAddress) ||
        (titleMatch && stopTitle && titleMatch === stopTitle)
      );
    }) || null
  );
};

const resolveStudentStop = (student, stops) => {
  if (!student || !stops.length) return null;

  const stopAddress = toText(student.profile?.stopAddress);
  const stopAddressNoCity = firstAddressSegment(stopAddress);
  const addressNorm = normalizeMatchText(stopAddress);
  const addressNoCityNorm = normalizeMatchText(stopAddressNoCity);

  const byAddress = stops.find((item) => {
    const stopAddressNorm = normalizeMatchText(item.address);
    const stopTitleNorm = normalizeMatchText(item.title);
    if (!stopAddressNorm && !stopTitleNorm) return false;

    return (
      (addressNorm && (addressNorm === stopAddressNorm || addressNorm === stopTitleNorm)) ||
      (addressNoCityNorm &&
        (addressNoCityNorm === stopAddressNorm || addressNoCityNorm === stopTitleNorm))
    );
  });

  if (byAddress) return byAddress;

  if (!addressNorm && !addressNoCityNorm) return null;

  return (
    stops.find((item) => {
      const stopAddressNorm = normalizeMatchText(item.address);
      const stopTitleNorm = normalizeMatchText(item.title);
      return (
        (addressNorm &&
          stopAddressNorm &&
          (stopAddressNorm.includes(addressNorm) || addressNorm.includes(stopAddressNorm))) ||
        (addressNoCityNorm &&
          ((stopAddressNorm &&
            (stopAddressNorm.includes(addressNoCityNorm) ||
              addressNoCityNorm.includes(stopAddressNorm))) ||
            (stopTitleNorm &&
              (stopTitleNorm.includes(addressNoCityNorm) ||
                addressNoCityNorm.includes(stopTitleNorm)))))
      );
    }) || null
  );
};

const buildRemainingStopsMessage = (name, remainingStops) => {
  const unit = remainingStops === 1 ? "parada" : "paradas";
  return `Estamos a ${remainingStops} ${unit} de recoger a ${name}`;
};

const buildDistanceMessage = (name, distanceMeters) => {
  if (distanceMeters === 1000) {
    return `Estamos a 1km de llegar por ${name}!`;
  }
  return `Estamos a ${distanceMeters}m de llegar por ${name}!`;
};

const buildPickedUpMessage = (name) => {
  return `${name} ya esta en la ruta; En camino al colegio! :)`;
};

const hydrateStudentProfileFromCode = async (db, student) => {
  if (!student || !student.profile) return student;

  const hasStopAddress = Boolean(toText(student.profile?.stopAddress));
  const studentCode = toText(student.profile?.studentCode);
  if (hasStopAddress || !studentCode) return student;

  try {
    const codeSnap = await db.collection("studentCodes").doc(studentCode).get();
    if (!codeSnap.exists) return student;
    const codeData = codeSnap.data() || {};
    const mergedProfile = {
      ...student.profile,
      studentName: student.profile.studentName || codeData.studentName || null,
      stopAddress: student.profile.stopAddress || codeData.stopAddress || null,
      route: student.profile.route || codeData.route || null,
      institutionCode:
        student.profile.institutionCode || codeData.institutionCode || null,
      institutionName:
        student.profile.institutionName || codeData.institutionName || null,
    };

    if (toText(mergedProfile.stopAddress)) {
      await db
        .collection("users")
        .doc(student.uid)
        .set(
          {
            studentName: mergedProfile.studentName || null,
            stopAddress: mergedProfile.stopAddress || null,
            route: mergedProfile.route || null,
            institutionCode: mergedProfile.institutionCode || null,
            institutionName: mergedProfile.institutionName || null,
          },
          { merge: true }
        );
    }

    return {
      ...student,
      profile: mergedProfile,
      routeId: normalizeRouteId(mergedProfile?.route),
    };
  } catch (error) {
    return student;
  }
};

const isSameStop = (a, b) => {
  if (!a || !b) return false;
  if (a.key && b.key && a.key === b.key) return true;
  const addressA = normalizeMatchText(a.address);
  const addressB = normalizeMatchText(b.address);
  if (addressA && addressB && addressA === addressB) return true;
  const titleA = normalizeMatchText(a.title);
  const titleB = normalizeMatchText(b.title);
  if (titleA && titleB && titleA === titleB) return true;
  return false;
};

export async function POST(request) {
  const token = readBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let adminAuth;
  let db;
  let messaging;
  try {
    adminAuth = getAdminAuth();
    db = getAdminDb();
    messaging = getAdminMessaging();
  } catch (error) {
    return NextResponse.json(
      {
        error: "Firebase Admin no configurado",
        detail:
          "Define FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL y FIREBASE_ADMIN_PRIVATE_KEY.",
      },
      { status: 500 }
    );
  }

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch (error) {
    return NextResponse.json({ error: "Token invalido" }, { status: 401 });
  }

  const monitorUid = decoded.uid;
  const monitorRef = db.collection("users").doc(monitorUid);
  const monitorSnap = await monitorRef.get();
  if (!monitorSnap.exists) {
    return NextResponse.json({ error: "Perfil no encontrado" }, { status: 403 });
  }

  const monitorProfile = monitorSnap.data() || {};
  if (!isMonitorProfile(monitorProfile)) {
    return NextResponse.json({ error: "Solo monitoras autorizadas" }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  const eventType = toLowerText(body?.eventType);
  if (eventType !== EVENT_TYPES.ETA_UPDATE && eventType !== EVENT_TYPES.STOP_STATUS_UPDATE) {
    return NextResponse.json({ error: "eventType invalido" }, { status: 400 });
  }

  const monitorRouteId = normalizeRouteId(monitorProfile?.route);
  const routeId = normalizeRouteId(body?.routeId || body?.route || monitorRouteId);
  if (!routeId) {
    return NextResponse.json({ error: "No se pudo resolver la ruta" }, { status: 400 });
  }

  const institutionCode =
    toText(monitorProfile?.institutionCode) || toText(body?.institutionCode);

  const stops = buildStops(body?.stops || []);
  if (!stops.length) {
    return NextResponse.json(
      {
        ok: true,
        sent: 0,
        skipped: 0,
        reason: "Sin paraderos para evaluar",
      },
      { status: 200 }
    );
  }

  const changedStop = findChangedStop(body?.changedStop, stops);
  const changedStopStatus = toLowerText(body?.changedStop?.status || changedStop?.status);

  const studentsSnap = institutionCode
    ? await db.collection("users").where("institutionCode", "==", institutionCode).get()
    : await db.collection("users").get();

  const baseStudentCandidates = studentsSnap.docs
    .map((item) => {
      const profile = item.data() || {};
      return {
        uid: item.id,
        profile,
        routeId: normalizeRouteId(profile?.route),
      };
    })
    .filter((student) => {
      if (!isStudentProfile(student.profile)) return false;
      return true;
    });

  const studentCandidates = await Promise.all(
    baseStudentCandidates.map((student) => hydrateStudentProfileFromCode(db, student))
  );

  if (!studentCandidates.length) {
    return NextResponse.json(
      {
        ok: true,
        sent: 0,
        skipped: 0,
        diagnostics: {
          reason: "no-students-matched",
          routeId,
          institutionCode: institutionCode || null,
        },
      },
      { status: 200 }
    );
  }

  const dateKey = getServiceDateKey();
  const stateRefs = studentCandidates.map((student) => {
    const stateId = buildStateId({ dateKey, routeId, uid: student.uid });
    return {
      uid: student.uid,
      ref: db.collection("routePushStates").doc(stateId),
    };
  });

  const stateSnapshots = await Promise.all(stateRefs.map((item) => item.ref.get()));
  const stateByUid = {};
  stateSnapshots.forEach((snapshot, index) => {
    const uid = stateRefs[index].uid;
    stateByUid[uid] = snapshot.exists ? snapshot.data() || {} : {};
  });

  const writes = [];
  let sent = 0;
  let skipped = 0;
  const diagnostics = {
    totalStudents: studentCandidates.length,
    attempted: 0,
    inAppDelivered: 0,
    unmatchedStop: 0,
    noTrigger: 0,
    noToken: 0,
    failedSend: 0,
    reasons: {},
  };

  for (const student of studentCandidates) {
    const studentStop = resolveStudentStop(student, stops);
    if (!studentStop) {
      diagnostics.unmatchedStop += 1;
      skipped += 1;
      continue;
    }

    const state = stateByUid[student.uid] || {};
    const name = getStudentDisplayName(student.profile);
    const statusValue = toLowerText(studentStop.status);
    const isMissed = studentStop.excluded || statusValue === STOP_STATUS.MISSED_BUS;
    const isBoarded = statusValue === STOP_STATUS.BOARDED;

    let message = "";
    let statePatch = null;

    if (eventType === EVENT_TYPES.ETA_UPDATE && !isMissed && !isBoarded) {
      const distanceMeters = parseNumber(studentStop.distanceMeters);
      if (distanceMeters !== null && distanceMeters <= 500 && !state.distance500Sent) {
        message = buildDistanceMessage(name, 500);
        statePatch = {
          distance1000Sent: true,
          distance500Sent: true,
        };
      } else if (distanceMeters !== null && distanceMeters <= 1000 && !state.distance1000Sent) {
        message = buildDistanceMessage(name, 1000);
        statePatch = {
          distance1000Sent: true,
        };
      }
    }

    if (
      !message &&
      eventType === EVENT_TYPES.STOP_STATUS_UPDATE &&
      changedStop &&
      changedStopStatus === STOP_STATUS.BOARDED
    ) {
      const sameStop = isSameStop(studentStop, changedStop);
      if (sameStop) {
        message = buildPickedUpMessage(name);
        statePatch = {
          pickedUpSent: true,
        };
      } else if (!isMissed && !isBoarded && studentStop.order > changedStop.order) {
        const remainingStops = studentStop.order - changedStop.order;
        if (
          remainingStops >= 1 &&
          parseInteger(state.lastStopsRemainingNotified) !== remainingStops
        ) {
          message = buildRemainingStopsMessage(name, remainingStops);
          statePatch = {
            lastStopsRemainingNotified: remainingStops,
          };
        }
      }
    }

    if (!message || !statePatch) {
      diagnostics.noTrigger += 1;
      skipped += 1;
      continue;
    }

    diagnostics.attempted += 1;
    const title = "Actualizacion de ruta";
    const inAppResult = await enqueueInAppNotification({ db, student, title, message });
    if (inAppResult.delivered) {
      diagnostics.inAppDelivered += 1;
    }
    const pushResult = await sendPushMessage({ messaging, db, student, title, message });
    if (!pushResult.delivered && !inAppResult.delivered) {
      if (pushResult.reason === "no-token") {
        diagnostics.noToken += 1;
      } else {
        diagnostics.failedSend += 1;
      }
      diagnostics.reasons[pushResult.reason || "unknown"] =
        (diagnostics.reasons[pushResult.reason || "unknown"] || 0) + 1;
      skipped += 1;
      continue;
    }

    sent += 1;
    const stateId = buildStateId({ dateKey, routeId, uid: student.uid });
    writes.push(
      db
        .collection("routePushStates")
        .doc(stateId)
        .set(
          {
            uid: student.uid,
            routeId,
            dateKey,
            institutionCode,
            monitorUid,
            updatedAt: FieldValue.serverTimestamp(),
            ...statePatch,
          },
          { merge: true }
        )
    );
  }

  if (writes.length) {
    await Promise.all(writes);
  }

  return NextResponse.json(
    {
      ok: true,
      sent,
      skipped,
      diagnostics: {
        ...diagnostics,
        routeId,
        institutionCode: institutionCode || null,
      },
    },
    { status: 200 }
  );
}
