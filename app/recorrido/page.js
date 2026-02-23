"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import AuthPanel from "../components/AuthPanel";
import { auth, db } from "../lib/firebaseClient";
import { geocodeAddressToCoords } from "../lib/geocodeClient";
import {
  getRouteId,
  loadRouteStopsForProfile,
  resolveRouteKey as resolveRouteKeyFromStops,
} from "../lib/routeStops";
import {
  createStopStatusMap,
  getServiceDateKey,
  isStopAbsentStatus,
  normalizeStopKey,
  STOP_STATUS,
  STOP_STATUS_LABEL,
} from "../lib/routeDailyStatus";

const ROUTE_STOPS_SUBCOLLECTIONS = ["direcciones", "addresses", "stops"];
const LOCATION_UPLOAD_INTERVAL_MS = 5000;
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 10000,
};

const toLowerText = (value) =>
  value === null || value === undefined ? "" : value.toString().trim().toLowerCase();

const normalizeMatchText = (value) =>
  value === null || value === undefined
    ? ""
    : value
        .toString()
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");

const getStudentDisplayName = (data) => {
  if (!data) return "";
  const fallbackName = [data.firstName, data.lastName].filter(Boolean).join(" ");
  const candidates = [
    data.studentName,
    data.displayName,
    data.fullName,
    data.name,
    fallbackName,
  ];
  return candidates
    .map((value) => (value === null || value === undefined ? "" : value.toString().trim()))
    .find(Boolean);
};

const addStudentToStopMap = (mapped, key, studentName) => {
  if (!key || !studentName) return;
  if (!Array.isArray(mapped[key])) {
    mapped[key] = [];
  }
  if (!mapped[key].some((name) => toLowerText(name) === toLowerText(studentName))) {
    mapped[key].push(studentName);
  }
};

const firstAddressSegment = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().split(",")[0]?.trim() || "";
};

const isMonitorProfile = (profile) => {
  const role = toLowerText(profile?.role);
  const accountType = toLowerText(profile?.accountType);
  return (
    role === "monitor" ||
    role === "monitora" ||
    accountType === "monitor" ||
    accountType === "monitora"
  );
};

const logLiveCoords = (source, position) => {
  const lat = Number(position?.coords?.latitude);
  const lng = Number(position?.coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const accuracy = Number(position?.coords?.accuracy);
  const sentAt = new Date().toISOString();
  const reportedAtMs = Number(position?.timestamp);
  const reportedAt = Number.isFinite(reportedAtMs)
    ? new Date(reportedAtMs).toISOString()
    : "unknown";
  const accuracyText = Number.isFinite(accuracy) ? ` +/-${Math.round(accuracy)}m` : "";
  console.log(
    `[SchoolWays GPS][${source}] sentAt=${sentAt} reportedAt=${reportedAt} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}${accuracyText}`
  );
};

const getRouteIdCandidates = ({ profile, routeKey, routeStopsByKey }) => {
  const candidates = new Set();
  const routeNameFromKey = routeKey ? routeKey.split(":").slice(1).join(":") : "";
  const fromKey = getRouteId(routeNameFromKey);
  const fromProfile = getRouteId(profile?.route);
  if (fromKey) candidates.add(fromKey);
  if (fromProfile) candidates.add(fromProfile);

  if (routeStopsByKey && typeof routeStopsByKey === "object") {
    Object.keys(routeStopsByKey).forEach((key) => {
      const routeName = key.includes(":") ? key.split(":").slice(1).join(":") : key;
      const routeId = getRouteId(routeName);
      if (routeId) candidates.add(routeId);
    });
  }

  return Array.from(candidates);
};

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const mergeStatusMaps = (maps = []) => {
  const merged = {};
  maps.forEach((mapped) => {
    if (!mapped || typeof mapped !== "object") return;
    Object.entries(mapped).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object") return;
      const current = merged[key];
      if (!current) {
        merged[key] = entry;
        return;
      }

      const currentAbsent =
        isStopAbsentStatus(current?.status) || current?.inasistencia === true;
      const incomingAbsent =
        isStopAbsentStatus(entry?.status) || entry?.inasistencia === true;

      if (incomingAbsent && !currentAbsent) {
        merged[key] = entry;
        return;
      }
      if (currentAbsent && !incomingAbsent) {
        return;
      }

      const incomingMillis = toMillis(entry?.updatedAt);
      const currentMillis = toMillis(current?.updatedAt);
      if (incomingMillis >= currentMillis) {
        merged[key] = entry;
      }
    });
  });
  return merged;
};

const toRadians = (value) => (value * Math.PI) / 180;

const distanceMetersBetween = (a, b) => {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }

  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aa =
    sinLat * sinLat +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinLng * sinLng;
  const cc = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return earthRadius * cc;
};

const parseDurationSeconds = (value) => {
  if (typeof value === "string" && value.endsWith("s")) {
    const parsed = Number.parseFloat(value.replace("s", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
};

const fetchRoutesData = async (points, options = {}, timeoutMs = 9000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points,
        optimizeWaypoints: Boolean(options?.optimizeWaypoints),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  } catch (error) {
    return { ok: false, data: {} };
  } finally {
    clearTimeout(timeoutId);
  }
};

const sumLegs = (legs, startIndex, endIndexInclusive) => {
  if (!Array.isArray(legs) || !legs.length) {
    return { distanceMeters: null, durationSeconds: null };
  }
  const start = Math.max(0, startIndex);
  const end = Math.min(legs.length - 1, endIndexInclusive);
  if (end < start) {
    return { distanceMeters: null, durationSeconds: null };
  }

  let distanceMeters = 0;
  let hasDistance = false;
  let durationSeconds = 0;
  let hasDuration = false;

  for (let index = start; index <= end; index += 1) {
    const leg = legs[index];
    if (typeof leg?.distanceMeters === "number") {
      distanceMeters += leg.distanceMeters;
      hasDistance = true;
    }
    const parsedDuration = parseDurationSeconds(leg?.duration);
    if (typeof parsedDuration === "number") {
      durationSeconds += parsedDuration;
      hasDuration = true;
    }
  }

  return {
    distanceMeters: hasDistance ? distanceMeters : null,
    durationSeconds: hasDuration ? durationSeconds : null,
  };
};

const fallbackMinutesFromDistance = (distanceMeters) => {
  if (typeof distanceMeters !== "number") return null;
  const km = distanceMeters / 1000;
  return Math.max(1, Math.round((km / 24) * 60));
};

export default function RecorridoPage() {
  const [profile, setProfile] = useState(null);
  const [busCoords, setBusCoords] = useState(null);
  const [stopEtas, setStopEtas] = useState([]);
  const [routeStopsByKey, setRouteStopsByKey] = useState({});
  const [dailyStopStatuses, setDailyStopStatuses] = useState({});
  const [studentsByStopKey, setStudentsByStopKey] = useState({});
  const [studentsCatalog, setStudentsCatalog] = useState([]);
  const [editingStopKey, setEditingStopKey] = useState("");
  const [savingStopKey, setSavingStopKey] = useState("");
  const [savingError, setSavingError] = useState("");
  const [pushSyncInfo, setPushSyncInfo] = useState("");
  const lastFetchRef = useRef(0);
  const lastLocationUploadRef = useRef(0);
  const locationWatchIdRef = useRef(null);
  const profileRef = useRef(null);
  const geocodedStopsRef = useRef(new Map());
  const geocodingStopsRef = useRef(new Map());
  const pushSyncRef = useRef({ at: 0, signature: "", inFlight: false });
  const router = useRouter();

  const isMonitor = isMonitorProfile(profile);

  const resolveRouteKey = (currentProfile) =>
    resolveRouteKeyFromStops(currentProfile, routeStopsByKey);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const getStopCoords = async (stop) => {
    if (!stop) return null;
    const lat = Number(stop?.coords?.lat);
    const lng = Number(stop?.coords?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }

    const address =
      stop?.address === null || stop?.address === undefined
        ? ""
        : stop.address.toString().trim();
    if (!address) return null;

    const key = address.toLowerCase();
    const cached = geocodedStopsRef.current.get(key);
    if (cached) return cached;

    const pending = geocodingStopsRef.current.get(key);
    if (pending) return pending;

    const request = geocodeAddressToCoords(address)
      .then((coords) => {
        if (coords) {
          geocodedStopsRef.current.set(key, coords);
        }
        return coords;
      })
      .finally(() => {
        geocodingStopsRef.current.delete(key);
      });

    geocodingStopsRef.current.set(key, request);
    return request;
  };

  const resolveRouteIdentity = (currentProfile) => {
    const routeKey = resolveRouteKey(currentProfile);
    const routeIds = getRouteIdCandidates({
      profile: currentProfile,
      routeKey,
      routeStopsByKey,
    });
    return { routeKey, routeId: routeIds[0] || null, routeIds };
  };

  const maybeUploadMonitorLocation = async (coords, currentProfileOverride = null) => {
    const currentUser = auth.currentUser;
    const currentProfile = currentProfileOverride || profileRef.current;
    if (!currentUser || !currentProfile || !isMonitorProfile(currentProfile)) return;

    const now = Date.now();
    if (now - lastLocationUploadRef.current < 5000) return;
    lastLocationUploadRef.current = now;

    const { routeIds } = resolveRouteIdentity(currentProfile);
    if (!Array.isArray(routeIds) || !routeIds.length) return;

    await Promise.allSettled(
      routeIds.map((routeId) => {
        const liveRef = doc(db, "routes", routeId, "live", "current");
        return setDoc(
          liveRef,
          {
            uid: currentUser.uid,
            route: currentProfile.route || "",
            lat: coords.lat,
            lng: coords.lng,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      })
    );
  };

  const syncRoutePush = async ({ eventType, changedStop = null, stopsOverride = null }) => {
    if (!isMonitor || !profile) return;
    const { routeId } = resolveRouteIdentity(profile);
    if (!routeId) return;

    const stopsSource = Array.isArray(stopsOverride) ? stopsOverride : stopEtas;
    if (!Array.isArray(stopsSource) || !stopsSource.length) return;

    const stops = stopsSource.map((item, index) => ({
      key: item.key || `paradero-${index + 1}`,
      title: item.title || `Paradero ${index + 1}`,
      address: item.address || null,
      order: typeof item.order === "number" ? item.order : item.sourceIndex ?? index,
      minutes: typeof item.minutes === "number" ? item.minutes : null,
      status: item.status || null,
      excluded: Boolean(item.excluded),
    }));

    const roundedBus = busCoords
      ? `${busCoords.lat.toFixed(4)},${busCoords.lng.toFixed(4)}`
      : "no-bus";
    const signature = `${eventType}:${routeId}:${roundedBus}:${stops
      .map((item) => `${item.key}:${item.minutes ?? "na"}:${item.status ?? "none"}`)
      .join("|")}:${changedStop?.key || "none"}:${changedStop?.status || "none"}`;
    const now = Date.now();
    const minWindowMs = eventType === "eta_update" ? 25000 : 0;
    if (
      pushSyncRef.current.inFlight ||
      (minWindowMs > 0 &&
        pushSyncRef.current.signature === signature &&
        now - pushSyncRef.current.at < minWindowMs)
    ) {
      return;
    }

    pushSyncRef.current = { at: now, signature, inFlight: true };

    try {
      const currentUser = auth.currentUser;
      if (!currentUser) return;
      const idToken = await currentUser.getIdToken();
      if (!idToken) return;

      const response = await fetch("/api/push/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          eventType,
          routeId,
          route: profile.route || null,
          institutionCode: profile.institutionCode || null,
          busCoords: busCoords || null,
          stops,
          changedStop,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (eventType === "stop_status_update") {
          setSavingError("Se guardo el paradero, pero fallo el envio de notificaciones.");
          setPushSyncInfo("");
        }
        console.error("Push sync failed", payload);
        return;
      }

      const sent = Number(payload?.sent || 0);
      const diagnostics = payload?.diagnostics || {};
      const attempted = Number(diagnostics?.attempted || 0);
      const noToken = Number(diagnostics?.noToken || 0);
      const failedSend = Number(diagnostics?.failedSend || 0);
      const noTrigger = Number(diagnostics?.noTrigger || 0);
      const unmatchedStop = Number(diagnostics?.unmatchedStop || 0);
      const changedStatus = toLowerText(changedStop?.status);
      const expectsPush =
        eventType === "stop_status_update" && changedStatus === STOP_STATUS.BOARDED;
      if (eventType === "stop_status_update") {
        if (sent > 0) {
          setPushSyncInfo(`Notificaciones enviadas: ${payload.sent}.`);
          setSavingError("");
        } else if (changedStatus === STOP_STATUS.MISSED_BUS) {
          // Marking "No asistio" should not be treated as push failure.
          setPushSyncInfo("");
          setSavingError("");
        } else {
          let reason = payload?.diagnostics?.reason || "";
          if (!reason && noToken > 0) {
            reason = "sin token web push en estudiantes";
          } else if (!reason && unmatchedStop > 0) {
            reason = "el paradero del estudiante no coincide con la ruta";
          } else if (!reason && noTrigger > 0) {
            reason = "evento sin regla de notificacion para ese estado";
          } else if (!reason && failedSend > 0) {
            reason = "fallo al enviar a Firebase";
          } else if (!reason) {
            reason = "sin coincidencias para enviar";
          }
          setPushSyncInfo(`No se envio notificacion (${reason}).`);
        }

        const shouldWarn = sent === 0 && (attempted > 0 || noToken > 0 || failedSend > 0);
        if (shouldWarn) {
          console.warn("Push sync sent 0 notifications", payload);
        }

        const shouldShowError =
          sent === 0 &&
          changedStatus !== STOP_STATUS.MISSED_BUS &&
          (noToken > 0 || failedSend > 0 || (expectsPush && attempted > 0));
        if (shouldShowError) {
          setSavingError(
            "Se guardo el paradero, pero no se pudo notificar. Revisa permisos de notificaciones y tokens."
          );
        } else {
          setSavingError("");
        }
      }
    } catch (error) {
      if (eventType === "stop_status_update") {
        setSavingError("Se guardo el paradero, pero fallo el envio de notificaciones.");
        setPushSyncInfo("");
      }
      console.error("Push sync request failed", error);
    } finally {
      pushSyncRef.current = {
        ...pushSyncRef.current,
        inFlight: false,
      };
    }
  };

  const findStudentsForStop = async (stop) => {
    if (!profile?.institutionCode || !stop?.address) return [];

    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("institutionCode", "==", profile.institutionCode));

    const snapshot = await getDocs(usersQuery);
    const targetAddress = normalizeMatchText(stop.address);
    const targetRouteId = getRouteId(profile?.route);
    if (!targetAddress) return [];

    return snapshot.docs
      .map((item) => ({ uid: item.id, data: item.data() }))
      .filter((item) => {
        const routeId = getRouteId(item.data?.route);
        const routeMatches = !targetRouteId || !routeId || routeId === targetRouteId;
        return normalizeMatchText(item.data?.stopAddress) === targetAddress && routeMatches;
      });
  };

  const syncStudentDailyRecord = async ({ stop, status }) => {
    let students = [];
    try {
      students = await findStudentsForStop(stop);
    } catch (error) {
      console.error("No se pudieron cargar los estudiantes del paradero", error);
      return;
    }
    if (!students.length) return;

    const dateKey = getServiceDateKey();
    const syncResults = await Promise.allSettled(
      students.map(async (student) => {
        const attendanceRef = doc(db, "users", student.uid, "asistencias", dateKey);
        if (!status) {
          await deleteDoc(attendanceRef);
          return;
        }
        await setDoc(
          attendanceRef,
          {
            fechaYHora: serverTimestamp(),
            asistencia: status === STOP_STATUS.BOARDED,
          }
        );
      })
    );

    const rejectedCount = syncResults.filter((result) => result.status === "rejected").length;
    if (rejectedCount > 0) {
      console.error(
        `Se guardo el estado del paradero, pero fallo la sincronizacion de ${rejectedCount} estudiante(s).`
      );
    }
  };

  const persistStopStatus = async ({ stop, status }) => {
    if (!isMonitor || !stop) return;

    const { routeId, routeIds } = resolveRouteIdentity(profile);
    if (!routeId || !routeIds.length) {
      setSavingError("No se pudo identificar la ruta.");
      return;
    }

    const stopKey = normalizeStopKey({ id: stop.key }) || normalizeStopKey(stop);
    if (!stopKey) {
      setSavingError("No se pudo identificar el paradero.");
      return;
    }

    setSavingError("");
    setSavingStopKey(stopKey);
    try {
      const dateKey = getServiceDateKey();
      const monitorUid = auth.currentUser?.uid || null;
      const isClearing = !status;
      const dailyRoots = ["routes", "rutas"];
      let wroteAny = false;
      let lastError = null;

      for (const candidateRouteId of routeIds) {
        for (const rootCollection of dailyRoots) {
          const dailyStopRef = doc(
            db,
            rootCollection,
            candidateRouteId,
            "daily",
            dateKey,
            "stops",
            stopKey
          );
          try {
            if (isClearing) {
              await deleteDoc(dailyStopRef);
            } else {
              await setDoc(
                dailyStopRef,
                {
                  stopId: stopKey,
                  stopTitle: stop.title || null,
                  stopAddress: stop.address || null,
                  status,
                  inasistencia: status === STOP_STATUS.MISSED_BUS,
                  route: profile.route || null,
                  institutionCode: profile.institutionCode || null,
                  monitorUid,
                  updatedAt: serverTimestamp(),
                },
                { merge: true }
              );
            }
            wroteAny = true;
          } catch (error) {
            lastError = error;
          }
        }
      }

      // Live exclusions are only supported under `routes/{routeId}/live/current` by rules.
      for (const candidateRouteId of routeIds) {
        const liveRef = doc(db, "routes", candidateRouteId, "live", "current");
        const excludedArrayUpdate =
          status === STOP_STATUS.MISSED_BUS ? arrayUnion(stopKey) : arrayRemove(stopKey);
        try {
          await setDoc(
            liveRef,
            {
              uid: monitorUid,
              route: profile.route || null,
              excludedStopKeys: excludedArrayUpdate,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          wroteAny = true;
        } catch (error) {
          lastError = error;
        }
      }

      if (!wroteAny) {
        throw lastError || new Error("No se pudo escribir el estado del paradero.");
      }

      const excluded = isStopAbsentStatus(status);
      setDailyStopStatuses((prev) => {
        if (isClearing) {
          if (!prev[stopKey]) return prev;
          const next = { ...prev };
          delete next[stopKey];
          return next;
        }
        return {
          ...prev,
          [stopKey]: {
            ...(prev[stopKey] || {}),
            id: stopKey,
            status,
            inasistencia: excluded,
            updatedAt: new Date(),
            monitorUid,
          },
        };
      });
      const nextRows = stopEtas.map((item) =>
        item.key === stopKey
          ? {
              ...item,
              status: isClearing ? null : status,
              inasistencia: isClearing ? false : excluded,
              excluded: isClearing ? false : excluded,
            }
          : item
      );
      setStopEtas(nextRows);

      await syncStudentDailyRecord({ stop, status });
      if (!isClearing) {
        await syncRoutePush({
          eventType: "stop_status_update",
          changedStop: {
            key: stopKey,
            title: stop.title || null,
            address: stop.address || null,
            status,
          },
          stopsOverride: nextRows,
        });
      }

      setEditingStopKey("");
    } catch (error) {
      console.error("No se pudo guardar el estado del paradero", error);
      setSavingError("No se pudo guardar el estado del paradero.");
    } finally {
      setSavingStopKey("");
    }
  };

  const handleMarkStop = async (stop, status) => {
    await persistStopStatus({ stop, status });
  };

  useEffect(() => {
    let unsubscribeProfile = null;
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (!currentUser) {
        setProfile(null);
        setBusCoords(null);
        setStopEtas([]);
        setDailyStopStatuses({});
        setStudentsByStopKey({});
        setStudentsCatalog([]);
        setEditingStopKey("");
        setSavingStopKey("");
        setSavingError("");
        setPushSyncInfo("");
        return;
      }

      const userRef = doc(db, "users", currentUser.uid);
      unsubscribeProfile = onSnapshot(
        userRef,
        (snap) => {
          setProfile(snap.exists() ? snap.data() : null);
        },
        () => {
          setProfile(null);
        }
      );
    });

    return () => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
      }
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribers = [];

    const loadRouteStops = async () => {
      if (!profile) {
        setRouteStopsByKey({});
        return null;
      }

      const loadedRoute = await loadRouteStopsForProfile(db, profile);
      if (cancelled) return;

      if (loadedRoute?.routeKey && Array.isArray(loadedRoute.stops)) {
        setRouteStopsByKey({ [loadedRoute.routeKey]: loadedRoute.stops });
        return loadedRoute;
      }

      setRouteStopsByKey({});
      return null;
    };

    const subscribeToRouteChanges = (loadedRoute) => {
      if (!loadedRoute?.sourcePath) return;
      const routePath = loadedRoute.sourcePath.split("/").filter(Boolean);
      if (routePath.length < 2) return;

      const refresh = () => {
        void loadRouteStops();
      };

      try {
        unsubscribers.push(onSnapshot(doc(db, ...routePath), refresh, () => null));
      } catch (error) {
        // ignore invalid route path subscription
      }

      ROUTE_STOPS_SUBCOLLECTIONS.forEach((collectionName) => {
        try {
          unsubscribers.push(
            onSnapshot(
              collection(db, ...routePath, collectionName),
              refresh,
              () => null
            )
          );
        } catch (error) {
          // ignore missing subcollection subscriptions
        }
      });
    };

    const initRouteStops = async () => {
      const loadedRoute = await loadRouteStops();
      if (cancelled) return;
      subscribeToRouteChanges(loadedRoute);
    };

    void initRouteStops();

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (error) {
          // ignore
        }
      });
    };
  }, [profile]);

  useEffect(() => {
    if (!profile || !isMonitor || !profile?.institutionCode) {
      setStudentsByStopKey({});
      setStudentsCatalog([]);
      return;
    }

    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("institutionCode", "==", profile.institutionCode));
    const targetRouteId = getRouteId(profile?.route);

    const unsubscribe = onSnapshot(
      usersQuery,
      (snapshot) => {
        const mapped = {};
        const catalog = [];
        snapshot.docs.forEach((item) => {
          const data = item.data() || {};
          const userRouteId = getRouteId(data?.route);
          if (targetRouteId && userRouteId && userRouteId !== targetRouteId) return;

          const studentName = getStudentDisplayName(data);
          if (!studentName) return;
          const stopAddress = data?.stopAddress || "";
          const stopAddressNoCity = firstAddressSegment(stopAddress);
          const byAddressKey = normalizeStopKey({ address: stopAddress });
          const byAddressNoCityKey = normalizeStopKey({ address: stopAddressNoCity });
          const byAddressMatch = normalizeMatchText(stopAddress);
          const byAddressNoCityMatch = normalizeMatchText(stopAddressNoCity);
          const byTitleMatch = normalizeMatchText(data?.stopTitle || "");

          addStudentToStopMap(mapped, byAddressKey, studentName);
          addStudentToStopMap(mapped, byAddressNoCityKey, studentName);
          addStudentToStopMap(mapped, byAddressMatch, studentName);
          addStudentToStopMap(mapped, byAddressNoCityMatch, studentName);
          addStudentToStopMap(mapped, byTitleMatch, studentName);

          catalog.push({
            name: studentName,
            stopAddressNormalized: byAddressMatch,
            stopAddressNoCityNormalized: byAddressNoCityMatch,
            routeId: userRouteId,
          });
        });
        setStudentsByStopKey(mapped);
        setStudentsCatalog(catalog);
      },
      (error) => {
        console.error("No se pudo leer la lista de estudiantes para paraderos", error);
        setStudentsByStopKey({});
        setStudentsCatalog([]);
      }
    );

    return () => unsubscribe();
  }, [profile, isMonitor]);

  useEffect(() => {
    if (!profile) {
      setDailyStopStatuses({});
      return;
    }

    const { routeIds } = resolveRouteIdentity(profile);
    if (!routeIds.length) {
      setDailyStopStatuses({});
      return;
    }

    const dateKey = getServiceDateKey();
    const sourceMaps = {};
    const unsubscribers = [];
    const roots = ["routes", "rutas"];

    const mergeAndSet = () => {
      setDailyStopStatuses(mergeStatusMaps(Object.values(sourceMaps)));
    };

    routeIds.forEach((routeId) => {
      roots.forEach((rootCollection) => {
        const sourceKey = `${rootCollection}:${routeId}`;
        const dailyStopsRef = collection(
          db,
          rootCollection,
          routeId,
          "daily",
          dateKey,
          "stops"
        );
        const unsubscribe = onSnapshot(
          dailyStopsRef,
          (snapshot) => {
            sourceMaps[sourceKey] = createStopStatusMap(snapshot.docs);
            mergeAndSet();
          },
          () => {
            sourceMaps[sourceKey] = {};
            mergeAndSet();
          }
        );
        unsubscribers.push(unsubscribe);
      });
    });

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [profile, routeStopsByKey]);

  useEffect(() => {
    setStopEtas((prev) =>
      prev.map((item) => {
        const statusData = dailyStopStatuses[item.key] || null;
        const statusValue = statusData?.status || null;
        const excluded = isStopAbsentStatus(statusValue);
        const inasistencia =
          typeof statusData?.inasistencia === "boolean"
            ? statusData.inasistencia
            : isStopAbsentStatus(statusValue);

        if (
          item.status === statusValue &&
          item.excluded === excluded &&
          item.inasistencia === inasistencia
        ) {
          return item;
        }

        return {
          ...item,
          status: statusValue,
          inasistencia,
          excluded,
        };
      })
    );
  }, [dailyStopStatuses]);

  useEffect(() => {
    if (!profile) return;

    const { routeId, routeKey } = resolveRouteIdentity(profile);
    if (!routeId) return;

    const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
    const initFirstStop = async () => {
      if (busCoords || !routeStops?.length) return;
      const firstWithCoords = routeStops.find((stop) => stop?.coords) || routeStops[0];
      const firstCoords = await getStopCoords(firstWithCoords);
      if (!firstCoords) return;
      setBusCoords((prev) => (prev ? prev : firstCoords));
    };
    void initFirstStop();

    const liveRef = doc(db, "routes", routeId, "live", "current");
    const unsubLive = onSnapshot(liveRef, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const lat = Number(data?.lat);
      const lng = Number(data?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setBusCoords({ lat, lng });
      }
    });

    return () => unsubLive();
  }, [profile, routeStopsByKey]);

  useEffect(() => {
    if (!profile || !isMonitor) return;
    if (!("geolocation" in navigator)) return;

    let cancelled = false;
    const onPosition = (position, options = {}) => {
      if (cancelled) return;
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const coords = { lat, lng };
      setBusCoords(coords);
      if (options.logSource) {
        logLiveCoords(options.logSource, position);
      }
      if (options.upload) {
        void maybeUploadMonitorLocation(coords, profile);
      }
    };

    const sendTick = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => onPosition(position, { upload: true, logSource: "monitor-5s-tick" }),
        () => null,
        GEOLOCATION_OPTIONS
      );
    };

    sendTick();
    const watchId = navigator.geolocation.watchPosition(
      (position) => onPosition(position, { upload: false }),
      () => null,
      GEOLOCATION_OPTIONS
    );
    const intervalId = window.setInterval(sendTick, LOCATION_UPLOAD_INTERVAL_MS);
    locationWatchIdRef.current = watchId;

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      if (watchId !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchId);
      }
      if (locationWatchIdRef.current === watchId) {
        locationWatchIdRef.current = null;
      }
    };
  }, [profile, isMonitor, routeStopsByKey]);

  useEffect(() => {
    const updateEtas = async () => {
      if (!profile || !busCoords) return;
      const { routeKey } = resolveRouteIdentity(profile);
      const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
      if (!routeStops?.length) {
        setStopEtas([]);
        return;
      }

      const now = Date.now();
      if (now - lastFetchRef.current < 20000) return;
      lastFetchRef.current = now;

      const resolvedStops = (
        await Promise.all(
          routeStops.map(async (stop, index) => {
            const coords = await getStopCoords(stop);
            return {
              id: stop.id || `paradero-${index + 1}`,
              key: normalizeStopKey(stop) || stop.id || `paradero-${index + 1}`,
              title: stop.title || `Paradero ${index + 1}`,
              address: stop.address || null,
              coords,
              sourceIndex: index,
            };
          })
        )
      ).filter(Boolean);

      const activeStops = resolvedStops.filter((stop) => {
        const statusValue = dailyStopStatuses[stop.key]?.status;
        return !isStopAbsentStatus(statusValue);
      });

      const activeWithCoords = activeStops.filter((stop) => Boolean(stop.coords));

      const schoolLat = Number(profile?.institutionLat);
      const schoolLng = Number(profile?.institutionLng);
      let schoolCoords =
        Number.isFinite(schoolLat) && Number.isFinite(schoolLng)
          ? { lat: schoolLat, lng: schoolLng }
          : null;
      if (!schoolCoords && profile?.institutionAddress) {
        schoolCoords = await geocodeAddressToCoords(profile.institutionAddress);
      }

      const points = [{ lat: busCoords.lat, lng: busCoords.lng }];
      activeWithCoords.forEach((stop) => points.push(stop.coords));
      if (schoolCoords) {
        points.push(schoolCoords);
      }

      let routeData = null;
      if (points.length >= 2) {
        const { ok, data } = await fetchRoutesData(points, {
          optimizeWaypoints: Boolean(schoolCoords && activeWithCoords.length > 1),
        });
        if (ok) {
          routeData = data;
        }
      }

      const optimizedIndexes = Array.isArray(routeData?.optimizedIntermediateWaypointIndex)
        ? routeData.optimizedIntermediateWaypointIndex
        : [];
      const orderedActive =
        schoolCoords && optimizedIndexes.length === activeWithCoords.length
          ? optimizedIndexes.map((index) => activeWithCoords[index]).filter(Boolean)
          : activeWithCoords;
      const legs = Array.isArray(routeData?.legs) ? routeData.legs : [];

      const metricsByKey = {};
      await Promise.all(
        orderedActive.map(async (stop, index) => {
          let distanceMeters = null;
          let durationSeconds = null;

          const fromLegs = sumLegs(legs, 0, index);
          if (typeof fromLegs.distanceMeters === "number") {
            distanceMeters = fromLegs.distanceMeters;
            durationSeconds = fromLegs.durationSeconds;
          } else if (stop.coords) {
            const fallbackDistance = distanceMetersBetween(busCoords, stop.coords);
            distanceMeters = fallbackDistance;
            const direct = await fetchRoutesData([
              { lat: busCoords.lat, lng: busCoords.lng },
              { lat: stop.coords.lat, lng: stop.coords.lng },
            ]);
            if (direct.ok) {
              distanceMeters =
                typeof direct.data?.distanceMeters === "number"
                  ? direct.data.distanceMeters
                  : fallbackDistance;
              durationSeconds = parseDurationSeconds(direct.data?.duration);
            }
          }

          metricsByKey[stop.key] = {
            order: index,
            distanceKm:
              typeof distanceMeters === "number" ? (distanceMeters / 1000).toFixed(1) : null,
            minutes:
              typeof durationSeconds === "number"
                ? Math.max(1, Math.round(durationSeconds / 60))
                : fallbackMinutesFromDistance(distanceMeters),
          };
        })
      );

      const rows = resolvedStops
        .map((stop) => {
          const statusData = dailyStopStatuses[stop.key] || null;
          const statusValue = statusData?.status || null;
          const excluded = isStopAbsentStatus(statusValue);
          const metrics = metricsByKey[stop.key] || null;
          return {
            key: stop.key,
            title: stop.title,
            address: stop.address,
            sourceIndex: stop.sourceIndex,
            minutes: metrics?.minutes ?? null,
            distanceKm: metrics?.distanceKm ?? null,
            order: metrics ? metrics.order : 1000 + stop.sourceIndex,
            status: statusValue,
            inasistencia:
              typeof statusData?.inasistencia === "boolean"
                ? statusData.inasistencia
                : isStopAbsentStatus(statusValue),
            excluded,
          };
        })
        .sort((a, b) => {
          if (a.order !== b.order) return a.order - b.order;
          return a.sourceIndex - b.sourceIndex;
        });

      setStopEtas(rows);
      void syncRoutePush({ eventType: "eta_update", stopsOverride: rows });
    };

    void updateEtas();
  }, [profile, busCoords, routeStopsByKey, dailyStopStatuses]);

  useEffect(() => {
    if (!profile || busCoords) return;
    const { routeKey } = resolveRouteIdentity(profile);
    const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
    if (!routeStops?.length) return;

    setStopEtas((prev) => {
      if (prev.length) return prev;
      return routeStops.map((stop, index) => {
        const key = normalizeStopKey(stop) || stop.id || `paradero-${index + 1}`;
        const statusData = dailyStopStatuses[key] || null;
        const statusValue = statusData?.status || null;
        return {
          key,
          title: stop.title || `Paradero ${index + 1}`,
          address: stop.address || null,
          minutes: null,
          distanceKm: null,
          sourceIndex: index,
          order: index,
          status: statusValue,
          inasistencia:
            typeof statusData?.inasistencia === "boolean"
              ? statusData.inasistencia
              : isStopAbsentStatus(statusValue),
          excluded: isStopAbsentStatus(statusValue),
        };
      });
    });
  }, [profile, busCoords, routeStopsByKey, dailyStopStatuses]);

  if (!profile) {
    return (
      <main className="map-page">
        <AuthPanel />
      </main>
    );
  }

  return (
    <main className="route-page">
      <div className="route-overlay">
        <AuthPanel />
        <header className="route-header">
          <h1>Recorrido</h1>
          <p>
            {isMonitor
              ? "Marca cada paradero: ✓ asistio o ✕ no asistio."
              : "Tiempo estimado hasta cada paradero."}
          </p>
        </header>

        {savingError ? <div className="route-save-error">{savingError}</div> : null}
        {pushSyncInfo && !savingError ? (
          <div className="route-save-success">{pushSyncInfo}</div>
        ) : null}

        <div className="route-list">
          {stopEtas.length ? (
            stopEtas.map((stop) => {
              const hasSavedStatus = Boolean(stop.status);
              const isEditing = editingStopKey === stop.key;
              const isSaving = savingStopKey === stop.key;
              const statusLabel = stop.status ? STOP_STATUS_LABEL[stop.status] || stop.status : "";
              const stopAddressNoCity = firstAddressSegment(stop.address);
              const stopStudentKeys = [
                normalizeStopKey({ address: stop.address }),
                normalizeStopKey({ address: stopAddressNoCity }),
                normalizeStopKey({ title: stop.title }),
                normalizeStopKey({ id: stop.key }),
                normalizeMatchText(stop.address),
                normalizeMatchText(stopAddressNoCity),
                normalizeMatchText(stop.title),
              ].filter(Boolean);
              const studentNames = [];
              const seenStudents = new Set();
              stopStudentKeys.forEach((key) => {
                (studentsByStopKey[key] || []).forEach((name) => {
                  const identity = toLowerText(name);
                  if (!identity || seenStudents.has(identity)) return;
                  seenStudents.add(identity);
                  studentNames.push(name);
                });
              });

              if (!studentNames.length) {
                const stopCandidates = [
                  normalizeMatchText(stop.title),
                  normalizeMatchText(stop.address),
                  normalizeMatchText(stopAddressNoCity),
                ].filter(Boolean);
                studentsCatalog.forEach((student) => {
                  const identity = toLowerText(student?.name);
                  if (!identity || seenStudents.has(identity)) return;
                  const studentCandidates = [
                    student.stopAddressNormalized,
                    student.stopAddressNoCityNormalized,
                  ].filter(Boolean);
                  const matches = stopCandidates.some((stopValue) =>
                    studentCandidates.some(
                      (studentValue) =>
                        studentValue === stopValue ||
                        studentValue.includes(stopValue) ||
                        stopValue.includes(studentValue)
                    )
                  );
                  if (!matches) return;
                  seenStudents.add(identity);
                  studentNames.push(student.name);
                });
              }
              const students = studentNames;
              return (
                <details
                  key={stop.key}
                  className={[
                    "route-item",
                    "route-item-detail",
                    stop.excluded ? "excluded" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isMonitor && hasSavedStatus && !isEditing ? (
                    <button
                      type="button"
                      className="route-item-edit"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setEditingStopKey(stop.key);
                      }}
                      aria-label="Editar estado"
                      title="Editar"
                    >
                      ✎
                    </button>
                  ) : null}

                  <summary className="route-item-summary">
                    <div className="route-item-info">
                      <div className="route-item-title">{stop.title}</div>
                      <div className="route-item-meta">
                        {stop.excluded
                          ? "No se incluye en el recorrido de hoy"
                          : `${stop.minutes !== null ? `${stop.minutes} min` : "-- min"} · ${
                              stop.distanceKm !== null ? `${stop.distanceKm} km` : "-- km"
                            }`}
                      </div>
                      {isMonitor && hasSavedStatus ? (
                        <div className="route-item-status-text">Estado: {statusLabel}</div>
                      ) : null}
                    </div>

                    {isMonitor ? (
                      <div
                        className="route-stop-controls"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <button
                          type="button"
                          className={[
                            "route-stop-action",
                            "success",
                            stop.status === STOP_STATUS.BOARDED ? "is-selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={isSaving || (hasSavedStatus && !isEditing)}
                          title="Se subio"
                          onClick={() => {
                            void handleMarkStop(stop, STOP_STATUS.BOARDED);
                          }}
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          className={[
                            "route-stop-action",
                            "warning",
                            stop.status === STOP_STATUS.MISSED_BUS ? "is-selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={isSaving || (hasSavedStatus && !isEditing)}
                          title="Lo dejo el bus"
                          onClick={() => {
                            void handleMarkStop(stop, STOP_STATUS.MISSED_BUS);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ) : null}
                  </summary>

                  <div className="route-item-actions">
                    {isMonitor ? (
                      <div className="route-item-students">
                        <div className="route-item-students-title">Estudiantes:</div>
                        <ul className="route-item-students-list">
                          {(students.length ? students : ["N/A"]).map((name) => (
                            <li key={`${stop.key}:${name}`}>{name}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="route-item-button"
                      onClick={() => {
                        const target = encodeURIComponent(stop.title);
                        router.push(`/?stop=${target}`);
                      }}
                    >
                      Ver paradero
                    </button>

                    {isMonitor && isEditing ? (
                      <button
                        type="button"
                        className="route-item-button secondary"
                        disabled={isSaving}
                        onClick={() => {
                          void handleMarkStop(stop, null);
                        }}
                      >
                        Desmarcar estado
                      </button>
                    ) : null}

                    {isMonitor && isEditing ? (
                      <button
                        type="button"
                        className="route-item-button secondary"
                        disabled={isSaving}
                        onClick={() => setEditingStopKey("")}
                      >
                        Cancelar edicion
                      </button>
                    ) : null}
                  </div>
                </details>
              );
            })
          ) : (
            <div className="route-empty">Cargando recorrido...</div>
          )}
        </div>

      </div>
    </main>
  );
}
