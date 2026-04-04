"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import AuthPanel from "./components/AuthPanel";
import {
  LOCATION_ENABLED_STORAGE_KEY,
  LOCATION_TICK_EVENT,
  LOCATION_TOGGLE_EVENT,
} from "./components/LiveLocationTicker";
import { auth, db } from "./lib/firebaseClient";
import { geocodeAddressToCoords } from "./lib/geocodeClient";
import { isMonitorProfile } from "./lib/profileRoles";
import { getRouteId, loadRouteStopsForProfile } from "./lib/routeStops";
import {
  createStopStatusMap,
  getServiceDateKey,
  isStopAbsentStatus,
  normalizeStopKey,
  STOP_STATUS,
  STOP_STATUS_LABEL,
} from "./lib/routeDailyStatus";

const LeafletRouteMap = dynamic(() => import("./components/LeafletRouteMap"), {
  ssr: false,
  loading: () => (
    <div className="map-loading-card">
      <div className="map-loading-spinner" />
      <div className="map-loading-text">Cargando mapa...</div>
    </div>
  ),
});

const BOGOTA = { lat: 4.711, lng: -74.0721 };
const ROUTE_DAILY_COLLECTIONS = ["routes", "rutas"];
const ROUTE_LIVE_COLLECTIONS = ["routes", "rutas"];
const TRAIL_ENABLED_STORAGE_KEY = "schoolways:trailEnabled";
const TRAIL_MIN_POINT_METERS = 8;
const ZOOM_NEAR = 16;
const ZOOM_STOP = 17;
const SHOW_SCHOOL_MARKER = false;
const MAX_LIVE_BUS_AGE_MS = 25000;
const MAX_LAST_KNOWN_BUS_AGE_MS = 10 * 60 * 1000;
const STUDENT_REFRESH_INTERVAL_MS = 5000;
const ROUTE_LOADING_OVERLAY_DELAY_MS = 150;
const ROUTE_LOADING_OVERLAY_MAX_MS = 2000;
const LOCAL_MONITOR_MAX_ACCURACY_METERS = 120;
const LOCAL_MONITOR_ACCURACY_DEGRADATION_METERS = 18;
const LOCAL_MONITOR_NOISY_JUMP_METERS = 160;
const LOCAL_MONITOR_STICKY_WINDOW_MS = 12000;
const EMPTY_AUTH_ACTIONS = Object.freeze({
  hasUser: false,
  canEnableNotifications: false,
  notificationsPending: false,
  notificationsMessage: "",
  logoutPending: false,
  enableNotifications: null,
  logout: null,
});

const toText = (value) => (value === null || value === undefined ? "" : value.toString().trim());

const normalizeMatchText = (value) =>
  toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

const firstAddressSegment = (value) => toText(value).split(",")[0]?.trim() || "";

const readBooleanStorage = (key, fallback) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "1";
};

const parseCoord = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const extractCoords = (value) => {
  if (!value) return null;
  const lat =
    parseCoord(value.lat) ??
    parseCoord(value.latitude) ??
    parseCoord(value._lat) ??
    (Array.isArray(value) ? parseCoord(value[0]) : null);
  const lng =
    parseCoord(value.lng) ??
    parseCoord(value.lon) ??
    parseCoord(value.long) ??
    parseCoord(value.longitude) ??
    parseCoord(value._long) ??
    (Array.isArray(value) ? parseCoord(value[1]) : null);
  if (lat === null || lng === null) return null;
  return { lat, lng };
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

const toRadians = (value) => (value * Math.PI) / 180;

const distanceMetersBetween = (from, to) => {
  if (!from || !to) return null;
  const lat1 = Number(from.lat);
  const lng1 = Number(from.lng);
  const lat2 = Number(to.lat);
  const lng2 = Number(to.lng);
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

const getProfileDisplayName = (profile) => {
  if (!profile || typeof profile !== "object") return "";
  const fallbackName = [profile.firstName, profile.lastName]
    .map(toText)
    .filter(Boolean)
    .join(" ");
  return (
    toText(profile.studentName) ||
    toText(profile.fullName) ||
    toText(profile.displayName) ||
    toText(profile.name) ||
    fallbackName
  );
};

const getProfileRouteLabel = (profile) => toText(profile?.route) || "Ruta";

const getInstitutionDisplayName = (profile) =>
  toText(profile?.institutionName || profile?.schoolName || profile?.school || profile?.institution);

const resolveStopStatusEntry = (stopStatusMap, stop) => {
  if (!stopStatusMap || !stop) return null;
  const candidates = [
    normalizeStopKey(stop),
    normalizeStopKey({ id: stop?.id }),
    normalizeStopKey({ key: stop?.key }),
    normalizeStopKey({ address: stop?.address }),
    normalizeStopKey({ title: stop?.title }),
  ].filter(Boolean);

  for (const key of candidates) {
    const entry = stopStatusMap[key];
    if (entry) return entry;
  }
  return null;
};

function HomeContent() {
  const searchParams = useSearchParams();
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState({ uid: "", profile: null });
  const [institutionSnapshot, setInstitutionSnapshot] = useState({
    name: "",
    address: "",
    coords: null,
  });
  const [routeSnapshot, setRouteSnapshot] = useState({
    requestKey: "",
    data: null,
    meta: null,
    error: "",
    loading: false,
  });
  const [routeUsers, setRouteUsers] = useState([]);
  const [statusMaps, setStatusMaps] = useState({});
  const [liveBusSources, setLiveBusSources] = useState({});
  const [resolvedStopCoords, setResolvedStopCoords] = useState({});
  const [resolvedSchoolCoords, setResolvedSchoolCoords] = useState(null);
  const [locationEnabled, setLocationEnabled] = useState(() =>
    readBooleanStorage(LOCATION_ENABLED_STORAGE_KEY, true)
  );
  const [trailEnabled, setTrailEnabled] = useState(() =>
    readBooleanStorage(TRAIL_ENABLED_STORAGE_KEY, false)
  );
  const [trailPoints, setTrailPoints] = useState([]);
  const [localMonitorCoords, setLocalMonitorCoords] = useState(null);
  const [localMonitorUpdatedAt, setLocalMonitorUpdatedAt] = useState(null);
  const [liveBusNowMs, setLiveBusNowMs] = useState(() => Date.now());
  const [markersLoadingVisible, setMarkersLoadingVisible] = useState(false);
  const [islandExpanded, setIslandExpanded] = useState(false);
  const [authActions, setAuthActions] = useState(EMPTY_AUTH_ACTIONS);
  const [pulse, setPulse] = useState(false);
  const [focusRequest, setFocusRequest] = useState(null);
  const focusCounterRef = useRef(0);
  const localMonitorFixRef = useRef({ coords: null, updatedAt: 0, accuracy: null });

  const profile = session.profile;
  const profileRouteSignature = profile
    ? [
        profile?.route,
        profile?.institutionCode,
        profile?.institutionAddress,
        profile?.institutionLat,
        profile?.institutionLng,
        profile?.stopAddress,
        profile?.role,
        profile?.accountType,
      ]
        .map(toText)
        .join("|")
    : "";

  const isProfileMonitor = isMonitorProfile(profile);
  const routeLookupProfile = useMemo(
    () =>
      profile
        ? {
            route: profile?.route || null,
            institutionCode: profile?.institutionCode || null,
            institutionName: profile?.institutionName || null,
          }
        : null,
    [profile]
  );
  const activeRouteRequestKey = useMemo(
    () =>
      [toText(profile?.institutionCode), getRouteId(profile?.route) || toText(profile?.route)]
        .filter(Boolean)
        .join(":"),
    [profile?.institutionCode, profile?.route]
  );

  const queueFocus = useCallback((coords, zoom = ZOOM_NEAR, reason = "focus") => {
    if (!coords) return;
    focusCounterRef.current += 1;
    setFocusRequest({
      key: `${reason}:${focusCounterRef.current}`,
      coords,
      zoom,
    });
  }, []);

  const acceptLocalMonitorFix = useCallback(
    (coords, updatedAt = Date.now(), accuracy = null) => {
      if (!coords) return null;

      const numericAccuracy = Number(accuracy);
      const nextAccuracy = Number.isFinite(numericAccuracy) ? numericAccuracy : null;
      if (nextAccuracy !== null && nextAccuracy > LOCAL_MONITOR_MAX_ACCURACY_METERS) {
        return null;
      }

      const previousFix = localMonitorFixRef.current || {
        coords: null,
        updatedAt: 0,
        accuracy: null,
      };
      const previousCoords = previousFix.coords || null;
      const previousAccuracy = Number.isFinite(Number(previousFix.accuracy))
        ? Number(previousFix.accuracy)
        : null;
      const jumpMeters = distanceMetersBetween(previousCoords, coords);
      const updatedDeltaMs = Math.max(0, updatedAt - (previousFix.updatedAt || 0));

      if (previousCoords && typeof jumpMeters === "number") {
        if (jumpMeters < 3 && updatedDeltaMs < 1200) {
          return previousCoords;
        }

        const degradedAccuracy =
          nextAccuracy !== null &&
          previousAccuracy !== null &&
          nextAccuracy > previousAccuracy + LOCAL_MONITOR_ACCURACY_DEGRADATION_METERS;
        const noisyLargeJump =
          nextAccuracy !== null &&
          nextAccuracy > 80 &&
          jumpMeters > LOCAL_MONITOR_NOISY_JUMP_METERS;

        if (
          (degradedAccuracy && jumpMeters > 30 && updatedDeltaMs < LOCAL_MONITOR_STICKY_WINDOW_MS) ||
          noisyLargeJump
        ) {
          return previousCoords;
        }
      }

      localMonitorFixRef.current = {
        coords,
        updatedAt,
        accuracy: nextAccuracy,
      };
      setLocalMonitorCoords(coords);
      setLocalMonitorUpdatedAt(updatedAt);

      if (!trailEnabled) {
        return coords;
      }

      setTrailPoints((current) => {
        const previousTrail = current.length ? current[current.length - 1] : null;
        const trailJumpMeters = distanceMetersBetween(previousTrail, coords);
        if (
          previousTrail &&
          typeof trailJumpMeters === "number" &&
          trailJumpMeters < TRAIL_MIN_POINT_METERS
        ) {
          return current;
        }
        return [...current, coords];
      });

      return coords;
    },
    [trailEnabled]
  );

  useEffect(() => {
    let unsubscribeProfile = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      if (!user) {
        setSession({ uid: "", profile: null });
        setAuthReady(true);
        return;
      }

      const userRef = doc(db, "users", user.uid);
      unsubscribeProfile = onSnapshot(
        userRef,
        async (snapshot) => {
          let data = snapshot.exists() ? snapshot.data() : null;
          if (data?.studentCode && (!data.route || !data.institutionCode || !data.stopAddress)) {
            try {
              const codeRef = doc(db, "studentCodes", data.studentCode);
              const codeSnap = await getDoc(codeRef);
              if (codeSnap.exists()) {
                const codeData = codeSnap.data();
                data = {
                  ...data,
                  route: data.route || codeData.route || null,
                  institutionCode: data.institutionCode || codeData.institutionCode || null,
                  institutionName: data.institutionName || codeData.institutionName || null,
                  institutionAddress:
                    data.institutionAddress || codeData.institutionAddress || null,
                  institutionLat: data.institutionLat ?? codeData.institutionLat ?? null,
                  institutionLng: data.institutionLng ?? codeData.institutionLng ?? null,
                  stopAddress: data.stopAddress || codeData.stopAddress || null,
                };
                await setDoc(userRef, data, { merge: true });
              }
            } catch (error) {
              console.error("No se pudo completar el perfil desde studentCodes", error);
            }
          }

          setSession({ uid: user.uid, profile: data });
          setAuthReady(true);
        },
        () => {
          setSession({ uid: user.uid, profile: null });
          setAuthReady(true);
        }
      );
    });

    return () => {
      if (unsubscribeProfile) unsubscribeProfile();
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      setIslandExpanded(false);
      setFocusRequest(null);
      setTrailPoints([]);
      setLocalMonitorCoords(null);
      setLocalMonitorUpdatedAt(null);
      localMonitorFixRef.current = { coords: null, updatedAt: 0, accuracy: null };
      setResolvedStopCoords({});
      setResolvedSchoolCoords(null);
      setInstitutionSnapshot({ name: "", address: "", coords: null });
      setMarkersLoadingVisible(false);
      setRouteSnapshot({
        requestKey: "",
        data: null,
        meta: null,
        error: "",
        loading: false,
      });
      setRouteUsers([]);
      setStatusMaps({});
      setLiveBusSources({});
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [profileRouteSignature]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncFromStorage = (event) => {
      if (
        event?.key &&
        event.key !== LOCATION_ENABLED_STORAGE_KEY &&
        event.key !== TRAIL_ENABLED_STORAGE_KEY
      ) {
        return;
      }
      setLocationEnabled(readBooleanStorage(LOCATION_ENABLED_STORAGE_KEY, true));
      setTrailEnabled(readBooleanStorage(TRAIL_ENABLED_STORAGE_KEY, false));
    };

    const syncFromToggleEvent = () => {
      setLocationEnabled(readBooleanStorage(LOCATION_ENABLED_STORAGE_KEY, true));
    };

    syncFromStorage();
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(LOCATION_TOGGLE_EVENT, syncFromToggleEvent);
    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(LOCATION_TOGGLE_EVENT, syncFromToggleEvent);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setLiveBusNowMs(Date.now());
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!isProfileMonitor || !locationEnabled) return;

    const handleLocationTick = (event) => {
      const detail = event?.detail || {};
      const coords = extractCoords(detail);
      if (!coords) return;
      const updatedAt = Date.parse(detail.reportedAt || detail.sentAt || "") || Date.now();
      acceptLocalMonitorFix(coords, updatedAt, detail.accuracy);
    };

    window.addEventListener(LOCATION_TICK_EVENT, handleLocationTick);
    return () => {
      window.removeEventListener(LOCATION_TICK_EVENT, handleLocationTick);
    };
  }, [acceptLocalMonitorFix, isProfileMonitor, locationEnabled]);

  useEffect(() => {
    if (!profile?.institutionCode) return () => null;

    const institutionRef = doc(db, "institutions", profile.institutionCode);
    const unsubscribe = onSnapshot(
      institutionRef,
      (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : {};
        setInstitutionSnapshot({
          name:
            toText(data?.name) ||
            toText(data?.institutionName) ||
            toText(profile?.institutionName),
          address: toText(data?.address) || toText(profile?.institutionAddress),
          coords:
            extractCoords(data) ||
            extractCoords(data?.coords) ||
            extractCoords({
              lat: profile?.institutionLat,
              lng: profile?.institutionLng,
            }),
        });
      },
      () => {
        setInstitutionSnapshot({
          name: toText(profile?.institutionName),
          address: toText(profile?.institutionAddress),
          coords: extractCoords({
            lat: profile?.institutionLat,
            lng: profile?.institutionLng,
          }),
        });
      }
    );

    return () => unsubscribe();
  }, [
    profile?.institutionAddress,
    profile?.institutionCode,
    profile?.institutionLat,
    profile?.institutionLng,
    profile?.institutionName,
  ]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeMeta = null;
    let startLoadingTimerId = null;
    if (!routeLookupProfile || !activeRouteRequestKey) return () => null;

    startLoadingTimerId = window.setTimeout(() => {
      setRouteSnapshot((current) => {
        const isSameRequest = current.requestKey === activeRouteRequestKey;
        return {
          requestKey: activeRouteRequestKey,
          data: isSameRequest ? current.data : null,
          meta: isSameRequest ? current.meta : null,
          error: "",
          loading: true,
        };
      });
    }, 0);

    void loadRouteStopsForProfile(db, routeLookupProfile)
      .then((loadedRoute) => {
        if (cancelled) return;
        if (!loadedRoute) {
          setRouteSnapshot({
            requestKey: activeRouteRequestKey,
            data: null,
            meta: null,
            error: "No se encontró una ruta en Firebase para esta cuenta.",
            loading: false,
          });
          return;
        }

        setRouteSnapshot({
          requestKey: activeRouteRequestKey,
          data: loadedRoute,
          meta: null,
          error: "",
          loading: false,
        });

        if (!loadedRoute.sourcePath) return;
        const path = loadedRoute.sourcePath.split("/").filter(Boolean);
        if (path.length < 2) return;

        unsubscribeMeta = onSnapshot(
          doc(db, ...path),
          (snapshot) => {
            if (cancelled) return;
            setRouteSnapshot((current) =>
              current.requestKey !== activeRouteRequestKey
                ? current
                : {
                    ...current,
                    meta: snapshot.exists() ? snapshot.data() : null,
                  }
            );
          },
          () => {
            if (cancelled) return;
            setRouteSnapshot((current) =>
              current.requestKey !== activeRouteRequestKey
                ? current
                : {
                    ...current,
                    meta: null,
                  }
            );
          }
        );
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("No se pudo cargar la ruta", error);
        setRouteSnapshot({
          requestKey: activeRouteRequestKey,
          data: null,
          meta: null,
          error: "No se pudo leer la ruta desde Firebase.",
          loading: false,
        });
      });

    return () => {
      cancelled = true;
      if (startLoadingTimerId) {
        window.clearTimeout(startLoadingTimerId);
      }
      if (unsubscribeMeta) unsubscribeMeta();
    };
  }, [activeRouteRequestKey, routeLookupProfile]);

  useEffect(() => {
    if (!session.uid || !activeRouteRequestKey) {
      const resetTimerId = window.setTimeout(() => {
        setMarkersLoadingVisible(false);
      }, 0);
      return () => {
        window.clearTimeout(resetTimerId);
      };
    }

    let visible = true;
    const showTimerId = window.setTimeout(() => {
      if (visible) {
        setMarkersLoadingVisible(true);
      }
    }, ROUTE_LOADING_OVERLAY_DELAY_MS);
    const hideTimerId = window.setTimeout(() => {
      if (visible) {
        setMarkersLoadingVisible(false);
      }
    }, ROUTE_LOADING_OVERLAY_MAX_MS);

    return () => {
      visible = false;
      window.clearTimeout(showTimerId);
      window.clearTimeout(hideTimerId);
    };
  }, [activeRouteRequestKey, session.uid]);

  useEffect(() => {
    if (routeSnapshot.loading && !routeSnapshot.data?.stops?.length && !routeSnapshot.error) {
      return () => null;
    }

    const hideTimerId = window.setTimeout(() => {
      setMarkersLoadingVisible(false);
    }, 0);
    return () => {
      window.clearTimeout(hideTimerId);
    };
  }, [routeSnapshot.data?.stops?.length, routeSnapshot.error, routeSnapshot.loading]);

  useEffect(() => {
    if (!profile?.institutionCode) return () => null;

    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("institutionCode", "==", profile.institutionCode));
    const unsubscribe = onSnapshot(
      usersQuery,
      (snapshot) => {
        setRouteUsers(snapshot.docs.map((item) => ({ uid: item.id, ...(item.data() || {}) })));
      },
      () => {
        setRouteUsers([]);
      }
    );

    return () => unsubscribe();
  }, [profile?.institutionCode]);

  const routeId = useMemo(() => {
    const values = [
      routeSnapshot.data?.routeId,
      getRouteId(routeSnapshot.meta?.route),
      getRouteId(routeSnapshot.meta?.name),
      getRouteId(profile?.route),
    ].filter(Boolean);
    return values[0] || "";
  }, [profile?.route, routeSnapshot.data?.routeId, routeSnapshot.meta?.name, routeSnapshot.meta?.route]);

  const routeCandidateIds = useMemo(() => {
    const values = [
      routeId,
      getRouteId(profile?.route),
      getRouteId(routeSnapshot.meta?.route),
      getRouteId(routeSnapshot.meta?.name),
      routeSnapshot.data?.routeId,
    ];
    return [...new Set(values.filter(Boolean))];
  }, [
    profile?.route,
    routeId,
    routeSnapshot.data?.routeId,
    routeSnapshot.meta?.name,
    routeSnapshot.meta?.route,
  ]);

  useEffect(() => {
    if (!routeCandidateIds.length) return () => null;

    const unsubscribers = [];
    routeCandidateIds.forEach((candidateId) => {
      ROUTE_LIVE_COLLECTIONS.forEach((rootCollection) => {
        const sourceKey = `${rootCollection}:${candidateId}`;
        unsubscribers.push(
          onSnapshot(
            doc(db, rootCollection, candidateId, "live", "current"),
            (snapshot) => {
              setLiveBusSources((current) => {
                const next = { ...current };
                if (!snapshot.exists()) {
                  delete next[sourceKey];
                  return next;
                }
                const data = snapshot.data() || {};
                const coords = extractCoords(data);
                if (!coords) {
                  delete next[sourceKey];
                  return next;
                }
                const updatedAt = Math.max(
                  toMillis(data?.updatedAt),
                  parseCoord(data?.updatedAtClientMs) || 0,
                  parseCoord(data?.updatedAtMs) || 0
                );
                next[sourceKey] = {
                  coords,
                  updatedAt,
                  accuracy: parseCoord(data?.accuracy),
                };
                return next;
              });
            },
            () => {
              setLiveBusSources((current) => {
                const next = { ...current };
                delete next[sourceKey];
                return next;
              });
            }
          )
        );
      });
    });

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [routeCandidateIds]);

  useEffect(() => {
    if (isProfileMonitor || !routeCandidateIds.length) return () => null;

    let cancelled = false;
    const dateKey = getServiceDateKey();
    const refreshStudentRouteState = async () => {
      const liveTargets = routeCandidateIds.flatMap((candidateId) =>
        ROUTE_LIVE_COLLECTIONS.map((rootCollection) => ({
          sourceKey: `${rootCollection}:${candidateId}`,
          ref: doc(db, rootCollection, candidateId, "live", "current"),
        }))
      );

      const liveResults = await Promise.allSettled(
        liveTargets.map(async (target) => {
          const snapshot = await getDoc(target.ref);
          return {
            sourceKey: target.sourceKey,
            snapshot,
          };
        })
      );
      if (cancelled) return;

      setLiveBusSources((current) => {
        const next = { ...current };
        liveTargets.forEach((target) => {
          delete next[target.sourceKey];
        });
        liveResults.forEach((result) => {
          if (result.status !== "fulfilled") return;
          const { sourceKey, snapshot } = result.value;
          if (!snapshot.exists()) return;
          const data = snapshot.data() || {};
          const coords = extractCoords(data);
          if (!coords) return;
          next[sourceKey] = {
            coords,
            updatedAt: Math.max(
              toMillis(data?.updatedAt),
              parseCoord(data?.updatedAtClientMs) || 0,
              parseCoord(data?.updatedAtMs) || 0
            ),
            accuracy: parseCoord(data?.accuracy),
          };
        });
        return next;
      });

      const statusTargets = routeCandidateIds.flatMap((candidateId) =>
        ROUTE_DAILY_COLLECTIONS.map((rootCollection) => ({
          subKey: `${rootCollection}:${candidateId}:${dateKey}`,
          ref: collection(db, rootCollection, candidateId, "daily", dateKey, "stops"),
        }))
      );

      const statusResults = await Promise.allSettled(
        statusTargets.map(async (target) => {
          const snapshot = await getDocs(target.ref);
          return {
            subKey: target.subKey,
            docs: snapshot.docs,
          };
        })
      );
      if (cancelled) return;

      setStatusMaps((current) => {
        const next = { ...current };
        statusTargets.forEach((target) => {
          next[target.subKey] = {};
        });
        statusResults.forEach((result) => {
          if (result.status !== "fulfilled") return;
          next[result.value.subKey] = createStopStatusMap(result.value.docs);
        });
        return next;
      });
    };

    void refreshStudentRouteState();
    const intervalId = window.setInterval(() => {
      void refreshStudentRouteState();
    }, STUDENT_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isProfileMonitor, routeCandidateIds]);

  useEffect(() => {
    if (!routeCandidateIds.length) return () => null;

    const dateKey = getServiceDateKey();
    const unsubscribers = [];

    routeCandidateIds.forEach((candidateId) => {
      ROUTE_DAILY_COLLECTIONS.forEach((rootCollection) => {
        const subKey = `${rootCollection}:${candidateId}:${dateKey}`;
        unsubscribers.push(
          onSnapshot(
            collection(db, rootCollection, candidateId, "daily", dateKey, "stops"),
            (snapshot) => {
              setStatusMaps((current) => ({
                ...current,
                [subKey]: createStopStatusMap(snapshot.docs),
              }));
            },
            () => {
              setStatusMaps((current) => ({
                ...current,
                [subKey]: {},
              }));
            }
          )
        );
      });
    });

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [routeCandidateIds]);

  const serviceDateKey = useMemo(() => getServiceDateKey(), []);

  const mergedStatusMap = useMemo(() => {
    const activeMaps = Object.entries(statusMaps)
      .filter(([subKey]) => {
        const [, candidateId, dateKey] = subKey.split(":");
        if (dateKey !== serviceDateKey) return false;
        return !routeCandidateIds.length || routeCandidateIds.includes(candidateId);
      })
      .map(([, item]) => item);
    return mergeStatusMaps(activeMaps);
  }, [routeCandidateIds, serviceDateKey, statusMaps]);

  const liveBusSnapshot = useMemo(() => {
    const freshnessThreshold = liveBusNowMs - MAX_LIVE_BUS_AGE_MS;
    const entries = Object.entries(liveBusSources)
      .filter(([sourceKey]) => {
        const candidateId = sourceKey.split(":")[1];
        return !routeCandidateIds.length || routeCandidateIds.includes(candidateId);
      })
      .map(([, value]) => value)
      .filter((value) => value && Number(value.updatedAt || 0) >= freshnessThreshold)
      .sort((left, right) => {
        const timeDiff = (right.updatedAt || 0) - (left.updatedAt || 0);
        if (timeDiff !== 0) return timeDiff;
        const leftAccuracy = Number.isFinite(left?.accuracy)
          ? Number(left.accuracy)
          : Number.POSITIVE_INFINITY;
        const rightAccuracy = Number.isFinite(right?.accuracy)
          ? Number(right.accuracy)
          : Number.POSITIVE_INFINITY;
        return leftAccuracy - rightAccuracy;
      });
    return entries[0] || null;
  }, [liveBusNowMs, liveBusSources, routeCandidateIds]);

  const lastKnownLiveBusSnapshot = useMemo(() => {
    const freshnessThreshold = liveBusNowMs - MAX_LAST_KNOWN_BUS_AGE_MS;
    const entries = Object.entries(liveBusSources)
      .filter(([sourceKey]) => {
        const candidateId = sourceKey.split(":")[1];
        return !routeCandidateIds.length || routeCandidateIds.includes(candidateId);
      })
      .map(([, value]) => value)
      .filter((value) => value && Number(value.updatedAt || 0) >= freshnessThreshold)
      .sort((left, right) => {
        const timeDiff = (right.updatedAt || 0) - (left.updatedAt || 0);
        if (timeDiff !== 0) return timeDiff;
        const leftAccuracy = Number.isFinite(left?.accuracy)
          ? Number(left.accuracy)
          : Number.POSITIVE_INFINITY;
        const rightAccuracy = Number.isFinite(right?.accuracy)
          ? Number(right.accuracy)
          : Number.POSITIVE_INFINITY;
        return leftAccuracy - rightAccuracy;
      });
    return entries[0] || null;
  }, [liveBusNowMs, liveBusSources, routeCandidateIds]);

  const busCoords = useMemo(() => {
    if (isProfileMonitor && locationEnabled && localMonitorCoords) {
      return localMonitorCoords;
    }
    return liveBusSnapshot?.coords || lastKnownLiveBusSnapshot?.coords || null;
  }, [
    isProfileMonitor,
    lastKnownLiveBusSnapshot?.coords,
    liveBusSnapshot?.coords,
    localMonitorCoords,
    locationEnabled,
  ]);

  const lastLocationUpdatedAt = useMemo(() => {
    if (isProfileMonitor && locationEnabled && localMonitorUpdatedAt) {
      return localMonitorUpdatedAt;
    }
    return liveBusSnapshot?.updatedAt || lastKnownLiveBusSnapshot?.updatedAt || null;
  }, [
    isProfileMonitor,
    lastKnownLiveBusSnapshot?.updatedAt,
    liveBusSnapshot?.updatedAt,
    localMonitorUpdatedAt,
    locationEnabled,
  ]);

  const rawStops = useMemo(
    () => (Array.isArray(routeSnapshot.data?.stops) ? routeSnapshot.data.stops : []),
    [routeSnapshot.data]
  );

  useEffect(() => {
    if (!rawStops.length) return;
    let cancelled = false;

    rawStops.forEach((stop, index) => {
      const stopId = toText(stop?.id) || `paradero-${index + 1}`;
      if (extractCoords(stop?.coords) || resolvedStopCoords[stopId]) return;
      const address = toText(stop?.address);
      if (!address) return;

      void geocodeAddressToCoords(address).then((coords) => {
        if (cancelled || !coords) return;
        setResolvedStopCoords((current) =>
          current[stopId]
            ? current
            : {
                ...current,
                [stopId]: coords,
              }
        );
      });
    });

    return () => {
      cancelled = true;
    };
  }, [rawStops, resolvedStopCoords]);

  const schoolAddress = useMemo(
    () =>
      toText(
        routeSnapshot.meta?.schoolAddress ||
          routeSnapshot.meta?.institutionAddress ||
          institutionSnapshot.address ||
          profile?.institutionAddress
      ),
    [
      institutionSnapshot.address,
      profile?.institutionAddress,
      routeSnapshot.meta?.institutionAddress,
      routeSnapshot.meta?.schoolAddress,
    ]
  );

  useEffect(() => {
    if (resolvedSchoolCoords) return;
    const knownCoords =
      extractCoords(routeSnapshot.meta?.schoolCoords) ||
      extractCoords({
        lat: routeSnapshot.meta?.institutionLat,
        lng: routeSnapshot.meta?.institutionLng,
      }) ||
      institutionSnapshot.coords ||
      extractCoords({
        lat: profile?.institutionLat,
        lng: profile?.institutionLng,
      });
    if (knownCoords || !schoolAddress) return;

    let cancelled = false;
    void geocodeAddressToCoords(schoolAddress).then((coords) => {
      if (cancelled || !coords) return;
      setResolvedSchoolCoords(coords);
    });

    return () => {
      cancelled = true;
    };
  }, [
    institutionSnapshot.coords,
    profile?.institutionLat,
    profile?.institutionLng,
    resolvedSchoolCoords,
    routeSnapshot.meta?.institutionLat,
    routeSnapshot.meta?.institutionLng,
    routeSnapshot.meta?.schoolCoords,
    schoolAddress,
  ]);

  const schoolCoords = useMemo(
    () =>
      extractCoords(routeSnapshot.meta?.schoolCoords) ||
      extractCoords({
        lat: routeSnapshot.meta?.institutionLat,
        lng: routeSnapshot.meta?.institutionLng,
      }) ||
      institutionSnapshot.coords ||
      extractCoords({
        lat: profile?.institutionLat,
        lng: profile?.institutionLng,
      }) ||
      resolvedSchoolCoords,
    [
      institutionSnapshot.coords,
      profile?.institutionLat,
      profile?.institutionLng,
      resolvedSchoolCoords,
      routeSnapshot.meta?.institutionLat,
      routeSnapshot.meta?.institutionLng,
      routeSnapshot.meta?.schoolCoords,
    ]
  );

  const assignedStopAddress = useMemo(
    () => toText(profile?.stopAddress || profile?.studentStopAddress),
    [profile?.stopAddress, profile?.studentStopAddress]
  );

  const stops = useMemo(() => {
    return rawStops.map((stop, index) => {
      const stopId = toText(stop?.id) || `paradero-${index + 1}`;
      const coords = extractCoords(stop?.coords) || resolvedStopCoords[stopId] || null;
      const statusEntry = resolveStopStatusEntry(mergedStatusMap, {
        ...stop,
        id: stopId,
        coords,
      });
      const statusValue = statusEntry?.status || null;
      const address = toText(stop?.address);
      const title = toText(stop?.title) || `Paradero ${index + 1}`;
      const currentStopKey = normalizeMatchText(assignedStopAddress);
      const currentStopKeyNoCity = normalizeMatchText(firstAddressSegment(assignedStopAddress));
      const stopAddressKey = normalizeMatchText(address);
      const stopAddressNoCityKey = normalizeMatchText(firstAddressSegment(address));
      const stopTitleKey = normalizeMatchText(title);
      const isCurrent =
        Boolean(currentStopKey || currentStopKeyNoCity) &&
        [stopAddressKey, stopAddressNoCityKey, stopTitleKey].some(
          (candidate) =>
            candidate &&
            (candidate === currentStopKey || candidate === currentStopKeyNoCity)
        );
      const isBoarded = statusValue === STOP_STATUS.BOARDED;
      const isAbsent = isStopAbsentStatus(statusValue);

      return {
        ...stop,
        id: stopId,
        key: normalizeStopKey(stop) || stopId,
        title,
        address,
        coords,
        sourceIndex: index,
        order: index + 1,
        status: statusValue,
        statusLabel: isBoarded
          ? STOP_STATUS_LABEL[STOP_STATUS.BOARDED]
          : isAbsent
            ? STOP_STATUS_LABEL[STOP_STATUS.MISSED_BUS]
            : "Pendiente",
        isBoarded,
        isAbsent,
        isCurrent,
      };
    });
  }, [assignedStopAddress, mergedStatusMap, rawStops, resolvedStopCoords]);

  const stopOrderByAddress = useMemo(() => {
    const mapped = new Map();
    stops.forEach((stop) => {
      [stop.address, firstAddressSegment(stop.address), stop.title]
        .map(normalizeMatchText)
        .filter(Boolean)
        .forEach((key) => {
          if (!mapped.has(key)) {
            mapped.set(key, stop.order);
          }
        });
    });
    return mapped;
  }, [stops]);

  const currentStop = useMemo(() => stops.find((stop) => stop.isCurrent) || null, [stops]);
  const nextPendingStop = useMemo(
    () => stops.find((stop) => !stop.isBoarded && !stop.isAbsent) || null,
    [stops]
  );

  const visibleRouteUsers = useMemo(() => {
    const institutionCode = toText(profile?.institutionCode);
    return routeUsers.filter((item) => {
      if (institutionCode && toText(item?.institutionCode) !== institutionCode) return false;
      if (!routeCandidateIds.length) return true;
      const userRouteId = getRouteId(item?.route);
      return !userRouteId || routeCandidateIds.includes(userRouteId);
    });
  }, [profile?.institutionCode, routeCandidateIds, routeUsers]);

  const routeStudents = useMemo(
    () =>
      visibleRouteUsers.filter((item) => {
        if (isMonitorProfile(item)) return false;
        return Boolean(item?.studentCode || item?.studentName || item?.stopAddress);
      }),
    [visibleRouteUsers]
  );

  const routeMonitor = useMemo(
    () => visibleRouteUsers.find((item) => isMonitorProfile(item)) || null,
    [visibleRouteUsers]
  );

  const monitorDisplayName =
    getProfileDisplayName(routeMonitor || (isProfileMonitor ? profile : null)) ||
    "Monitora por confirmar";

  const studentStopOrder =
    stopOrderByAddress.get(normalizeMatchText(assignedStopAddress)) ||
    stopOrderByAddress.get(normalizeMatchText(firstAddressSegment(assignedStopAddress))) ||
    currentStop?.order ||
    null;

  const routeStudentEntries = useMemo(() => {
    return routeStudents.map((item) => {
      const displayName = getProfileDisplayName(item) || "Estudiante";
      const stopAddress = toText(item?.stopAddress);
      const order =
        stopOrderByAddress.get(normalizeMatchText(stopAddress)) ||
        stopOrderByAddress.get(normalizeMatchText(firstAddressSegment(stopAddress))) ||
        null;

      const keyCandidates = [
        normalizeStopKey({ address: stopAddress }),
        normalizeStopKey({ address: firstAddressSegment(stopAddress) }),
      ].filter(Boolean);
      let statusEntry = null;
      for (const key of keyCandidates) {
        if (mergedStatusMap[key]) {
          statusEntry = mergedStatusMap[key];
          break;
        }
      }

      return {
        uid: item.uid,
        name: displayName,
        stopAddress,
        order,
        picked: statusEntry?.status === STOP_STATUS.BOARDED,
      };
    });
  }, [mergedStatusMap, routeStudents, stopOrderByAddress]);

  const studentsTotal = routeStudentEntries.length;
  const studentsPicked = routeStudentEntries.filter((item) => item.picked).length;
  const studentsPending = Math.max(0, studentsTotal - studentsPicked);
  const sortedRouteStudentEntries = useMemo(
    () =>
      [...routeStudentEntries].sort((left, right) => {
        const leftOrder = Number.isFinite(left?.order) ? left.order : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(right?.order) ? right.order : Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.name.localeCompare(right.name, "es");
      }),
    [routeStudentEntries]
  );

  const profileRouteLabel = getProfileRouteLabel(profile);
  const monitorRouteLabel = getProfileRouteLabel(routeMonitor || profile);
  const profileInstitutionName = getInstitutionDisplayName(profile);
  const monitorInstitutionName =
    getInstitutionDisplayName(routeMonitor) ||
    institutionSnapshot.name ||
    profileInstitutionName;
  const schoolAddressLabel = firstAddressSegment(schoolAddress);
  const monitorSchoolLabel = monitorInstitutionName || schoolAddressLabel || "Colegio";
  const studentRouteSchoolLabel = `${monitorRouteLabel} - ${monitorSchoolLabel}`;
  const monitorRouteSchoolLabel = `${profileRouteLabel} - ${monitorSchoolLabel}`;
  const monitorNextStop = useMemo(
    () => ({
      title: nextPendingStop?.title || (schoolCoords ? "Colegio" : "--"),
      order: nextPendingStop?.order ?? null,
      source: "Firebase + IA",
    }),
    [nextPendingStop?.order, nextPendingStop?.title, schoolCoords]
  );

  const etaTarget = useMemo(() => {
    if (isProfileMonitor) {
      if (nextPendingStop?.coords) {
        return { title: "Siguiente paradero", coords: nextPendingStop.coords };
      }
      if (schoolCoords) {
        return { title: "Llegada al colegio", coords: schoolCoords };
      }
      return null;
    }

    if (currentStop?.coords && !currentStop.isBoarded && !currentStop.isAbsent) {
      return { title: "Llegada a tu paradero", coords: currentStop.coords };
    }
    if (schoolCoords) {
      return { title: "Llegada al colegio", coords: schoolCoords };
    }
    if (nextPendingStop?.coords) {
      return { title: "Llegada", coords: nextPendingStop.coords };
    }
    return null;
  }, [currentStop, isProfileMonitor, nextPendingStop, schoolCoords]);

  const etaDistanceMeters = useMemo(
    () => (busCoords && etaTarget?.coords ? distanceMetersBetween(busCoords, etaTarget.coords) : null),
    [busCoords, etaTarget]
  );
  const etaDistanceKm = useMemo(
    () =>
      typeof etaDistanceMeters === "number" && Number.isFinite(etaDistanceMeters)
        ? (etaDistanceMeters / 1000).toFixed(1)
        : null,
    [etaDistanceMeters]
  );
  const etaMinutes = useMemo(
    () =>
      typeof etaDistanceMeters === "number" && Number.isFinite(etaDistanceMeters)
        ? Math.max(1, Math.round(etaDistanceMeters / 400))
        : null,
    [etaDistanceMeters]
  );
  const etaTitle = etaTarget?.title || "Llegada";

  const profileDisplayName = getProfileDisplayName(profile) || "Estudiante";
  const lastUpdateLabel = Number.isFinite(lastLocationUpdatedAt)
    ? new Intl.DateTimeFormat("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(lastLocationUpdatedAt)
    : "--:--:--";
  const assignedStopLabel = assignedStopAddress || "Sin paradero asignado";
  const studentStopOrderLabel = studentStopOrder !== null ? `#${studentStopOrder}` : "--";
  const monitorNextStopOrderLabel =
    monitorNextStop.order !== null && monitorNextStop.order !== undefined
      ? `#${monitorNextStop.order}`
      : "--";
  const canEnableNotifications =
    Boolean(authActions?.canEnableNotifications) &&
    typeof authActions?.enableNotifications === "function";
  const canRunLogout = typeof authActions?.logout === "function";

  const markersLoading =
    markersLoadingVisible &&
    Boolean(profile) &&
    routeSnapshot.loading &&
    !routeSnapshot.data?.stops?.length;

  const selectedStop = useMemo(() => {
    const targetStop = toText(searchParams?.get("stop"));
    if (!targetStop) return null;
    const normalizedTarget = normalizeMatchText(targetStop);
    return (
      stops.find((stop) => {
        return [stop.title, stop.address, firstAddressSegment(stop.address)]
          .map(normalizeMatchText)
          .some((candidate) => candidate && candidate === normalizedTarget);
      }) || null
    );
  }, [searchParams, stops]);

  useEffect(() => {
    if (!selectedStop?.coords) return;
    queueFocus(selectedStop.coords, ZOOM_STOP, `stop:${selectedStop.id}`);
  }, [queueFocus, selectedStop?.coords, selectedStop?.id]);

  const preferredInitialStop = useMemo(
    () => (isProfileMonitor ? nextPendingStop || null : currentStop || null),
    [currentStop, isProfileMonitor, nextPendingStop]
  );

  const initialMapFocusCoords = useMemo(() => {
    if (busCoords) return busCoords;
    if (preferredInitialStop) return preferredInitialStop.coords || null;
    if (schoolCoords) return schoolCoords;
    return null;
  }, [busCoords, preferredInitialStop, schoolCoords]);

  const initialMapFocusPending = useMemo(
    () => !busCoords && Boolean(preferredInitialStop) && !preferredInitialStop?.coords,
    [busCoords, preferredInitialStop]
  );

  const mapViewportKey = useMemo(
    () =>
      [session.uid, activeRouteRequestKey || routeId || profileRouteLabel].filter(Boolean).join(":"),
    [activeRouteRequestKey, profileRouteLabel, routeId, session.uid]
  );

  const handleAuthActionsChange = useCallback((nextActions) => {
    if (!nextActions || typeof nextActions !== "object") {
      setAuthActions(EMPTY_AUTH_ACTIONS);
      return;
    }
    setAuthActions(nextActions);
  }, []);

  const handleCenter = useCallback(() => {
    const targetCoords = busCoords || currentStop?.coords || nextPendingStop?.coords || schoolCoords;
    if (targetCoords) {
      queueFocus(targetCoords, ZOOM_NEAR, "center");
      setPulse(true);
      window.setTimeout(() => setPulse(false), 600);
      return;
    }

    if (!isProfileMonitor || !locationEnabled) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = {
          lat: Number(position?.coords?.latitude),
          lng: Number(position?.coords?.longitude),
        };
        if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;
        const acceptedCoords = acceptLocalMonitorFix(
          coords,
          Number(position?.timestamp) || Date.now(),
          Number(position?.coords?.accuracy)
        );
        if (!acceptedCoords) return;
        queueFocus(acceptedCoords, ZOOM_NEAR, "center-live");
        setPulse(true);
        window.setTimeout(() => setPulse(false), 600);
      },
      () => null,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      }
    );
  }, [
    busCoords,
    currentStop?.coords,
    acceptLocalMonitorFix,
    isProfileMonitor,
    locationEnabled,
    nextPendingStop?.coords,
    queueFocus,
    schoolCoords,
  ]);

  const handleToggleLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = !locationEnabled;
    window.localStorage.setItem(LOCATION_ENABLED_STORAGE_KEY, next ? "1" : "0");
    window.dispatchEvent(new CustomEvent(LOCATION_TOGGLE_EVENT));
    setLocationEnabled(next);
    if (!next) {
      localMonitorFixRef.current = { coords: null, updatedAt: 0, accuracy: null };
      setLocalMonitorCoords(null);
      setLocalMonitorUpdatedAt(null);
    }
  }, [locationEnabled]);

  const handleToggleTrail = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = !trailEnabled;
    window.localStorage.setItem(TRAIL_ENABLED_STORAGE_KEY, next ? "1" : "0");
    setTrailEnabled(next);
    if (!next) {
      setTrailPoints([]);
      return;
    }
    if (localMonitorCoords) {
      setTrailPoints([localMonitorCoords]);
    }
  }, [localMonitorCoords, trailEnabled]);

  return (
    <main className="map-page">
      <AuthPanel onUserActionsChange={handleAuthActionsChange} />
      {markersLoading ? (
        <div className="map-loading-overlay" role="status" aria-live="polite">
          <div className="map-loading-card">
            <div className="map-loading-spinner" />
            <div className="map-loading-text">Cargando paraderos...</div>
          </div>
        </div>
      ) : null}
      <div
        className={profile ? "map-surface" : "map-surface hidden"}
        aria-label="Mapa"
      >
        {profile ? (
          <LeafletRouteMap
            busCoords={busCoords}
            schoolCoords={SHOW_SCHOOL_MARKER ? schoolCoords : null}
            stops={stops}
            trailPoints={trailPoints}
            focusRequest={focusRequest}
            viewportKey={mapViewportKey}
            initialFocusCoords={initialMapFocusCoords}
            initialFocusPending={initialMapFocusPending}
            initialFocusZoom={ZOOM_NEAR}
            selectedStopId={selectedStop?.id || ""}
          />
        ) : null}
      </div>
      {profile ? (
        <div className={islandExpanded ? "map-top-island-wrap expanded" : "map-top-island-wrap"}>
          <button
            type="button"
            className="map-top-island"
            onClick={() => setIslandExpanded((previous) => !previous)}
            aria-expanded={islandExpanded}
            aria-controls="map-top-island-panel"
            aria-label="Abrir resumen de ruta"
          >
            <div className="map-top-island-route">
              <span>{profileRouteLabel}</span>
              <span className="map-top-island-route-time">{lastUpdateLabel}</span>
            </div>
            <div className="map-top-island-name">{profileDisplayName}</div>
            <span className="map-top-island-chevron" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M5 7.75L10 12.25L15 7.75"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          <section
            id="map-top-island-panel"
            className={islandExpanded ? "map-top-island-panel open" : "map-top-island-panel"}
            aria-label="Detalles de la ruta"
            aria-hidden={!islandExpanded}
          >
            <div className="map-top-island-panel-scroll">
              <div className="map-top-island-card">
                <div className="map-top-island-label">Estado de ruta</div>
                <div className="map-top-island-value">{profileRouteLabel}</div>
                <div className="map-top-island-subline">
                  {monitorSchoolLabel} · Actualizado {lastUpdateLabel}
                </div>
              </div>
              {routeSnapshot.error ? (
                <div className="map-top-island-card">
                  <div className="map-top-island-label">Firebase</div>
                  <div className="map-top-island-subline">{routeSnapshot.error}</div>
                </div>
              ) : null}
              {isProfileMonitor ? (
                <>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Ruta asignada y colegio</div>
                    <div className="map-top-island-value">{monitorRouteSchoolLabel}</div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Paradero siguiente</div>
                    <div className="map-top-island-value">{monitorNextStop.title || "--"}</div>
                    <div className="map-top-island-subline">{monitorNextStop.source}</div>
                  </div>
                  <div className="map-top-island-grid">
                    <div className="map-top-island-mini">
                      <div className="map-top-island-label">Estudiantes de la ruta</div>
                      <div className="map-top-island-value">{studentsTotal}</div>
                    </div>
                    <div className="map-top-island-mini">
                      <div className="map-top-island-label">Estudiantes recogidos</div>
                      <div className="map-top-island-value">{studentsPicked}</div>
                    </div>
                    <div className="map-top-island-mini">
                      <div className="map-top-island-label">Estudiantes por recoger</div>
                      <div className="map-top-island-value">{studentsPending}</div>
                    </div>
                    <div className="map-top-island-mini">
                      <div className="map-top-island-label">Orden de paradero</div>
                      <div className="map-top-island-value">{monitorNextStopOrderLabel}</div>
                    </div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Estudiantes de la ruta</div>
                    {sortedRouteStudentEntries.length ? (
                      <ul className="map-top-island-student-list">
                        {sortedRouteStudentEntries.map((item) => (
                          <li
                            key={item.uid || `${item.name}:${item.stopAddress}`}
                            className={
                              item.picked
                                ? "map-top-island-student picked"
                                : "map-top-island-student"
                            }
                          >
                            <span className="map-top-island-student-name">{item.name}</span>
                            <span className="map-top-island-student-meta">
                              {item.order ? `#${item.order}` : "#--"} ·{" "}
                              {item.picked ? "Recogido" : "Pendiente"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="map-top-island-subline">
                        No hay estudiantes registrados en la ruta.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Nombre de la monitora</div>
                    <div className="map-top-island-value">{monitorDisplayName}</div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Ruta de la monitora y colegio</div>
                    <div className="map-top-island-value">{studentRouteSchoolLabel}</div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Paradero asignado</div>
                    <div className="map-top-island-value">{assignedStopLabel}</div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Orden de paradero</div>
                    <div className="map-top-island-value">{studentStopOrderLabel}</div>
                  </div>
                </>
              )}
              <div className="map-top-island-card map-top-island-actions-card">
                <div className="map-top-island-label">Opciones de cuenta</div>
                {canEnableNotifications ? (
                  <button
                    type="button"
                    className="map-top-island-action-button"
                    onClick={() => authActions.enableNotifications?.()}
                    disabled={Boolean(authActions?.notificationsPending)}
                  >
                    {authActions?.notificationsPending
                      ? "Activando notificaciones..."
                      : "Activar notificaciones"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="map-top-island-action-button danger"
                  onClick={() => {
                    if (!canRunLogout) return;
                    authActions.logout();
                  }}
                  disabled={!canRunLogout || Boolean(authActions?.logoutPending)}
                >
                  {authActions?.logoutPending ? "Cerrando sesión..." : "Cerrar sesión"}
                </button>
                {authActions?.notificationsMessage ? (
                  <div className="map-top-island-subline">{authActions.notificationsMessage}</div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {profile ? (
        <div className="eta-bubble" aria-live="polite">
          <div className="eta-bubble-inner">
            <div className="eta-title">{etaTitle}</div>
            <div className="eta-metric">{etaMinutes !== null ? `${etaMinutes} min` : "--"}</div>
            <div className="eta-sub">{etaDistanceKm !== null ? `${etaDistanceKm} km` : "-- km"}</div>
          </div>
        </div>
      ) : null}
      {profile && isProfileMonitor ? (
        <button
          type="button"
          className={trailEnabled ? "map-trail-toggle active" : "map-trail-toggle"}
          onClick={handleToggleTrail}
          aria-label={
            trailEnabled ? "Desactivar marcado del recorrido" : "Activar marcado del recorrido"
          }
          title={trailEnabled ? "Recorrido activo" : "Recorrido desactivado"}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M3.75 20.25h4.2l10.2-10.2a1.6 1.6 0 0 0 0-2.26l-1.95-1.95a1.6 1.6 0 0 0-2.26 0l-10.2 10.2v4.2Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M12.9 6.95l4.15 4.15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
      {profile && isProfileMonitor ? (
        <button
          type="button"
          className={locationEnabled ? "map-location-toggle active" : "map-location-toggle"}
          onClick={handleToggleLocation}
          aria-label={
            locationEnabled ? "Desactivar localización en vivo" : "Activar localización en vivo"
          }
          title={locationEnabled ? "Localización activa" : "Localización desactivada"}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M12 2.75a6.75 6.75 0 0 0-6.75 6.75c0 4.95 5.59 10.72 6.23 11.37a.75.75 0 0 0 1.04 0c.64-.65 6.23-6.42 6.23-11.37A6.75 6.75 0 0 0 12 2.75Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <circle cx="12" cy="9.5" r="2.35" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        className={pulse ? "map-control pulse" : "map-control"}
        onClick={handleCenter}
        aria-label="Centrar en mi ubicación"
        title="Centrar"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="12" cy="12" r="3.5" stroke="#1b2430" strokeWidth="2" />
          <path
            d="M12 3v3M12 18v3M3 12h3M18 12h3"
            stroke="#1b2430"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="map-page">
          <AuthPanel />
        </main>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
