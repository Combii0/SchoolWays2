"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
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
import {
  getRouteId,
  loadRouteStopsForProfile,
  resolveRouteKey as resolveRouteKeyFromStops,
} from "./lib/routeStops";
import {
  createStopStatusMap,
  getServiceDateKey,
  isStopAbsentStatus,
  normalizeStopKey,
  STOP_STATUS,
} from "./lib/routeDailyStatus";

const BOGOTA = { lat: 4.711, lng: -74.0721 };

const MAP_STYLE = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

const ZOOM_NEAR = 16;
const ZOOM_RESET = 15;
const MAX_FIT_ZOOM = 17;
const SHOW_SCHOOL_MARKER = false;
const STOP_REACHED_METERS = 180;
const MAP_MARKER_REFRESH_INTERVAL_MS = 4000;
const LAST_BUS_COORDS_STORAGE_KEY = "schoolways:last-bus-coords";
const MAP_STATE_STORAGE_KEY = "schoolways:mapState";
const TRAIL_ENABLED_STORAGE_KEY = "schoolways:trailEnabled";
const LAST_BUS_COORDS_MAX_AGE_MS = 90 * 1000;
const ROUTE_REFRESH_INTERVAL_MS = 120000;
const ETA_ESTIMATED_SPEED_KMH = 24;
const ROUTE_STOPS_SUBCOLLECTIONS = ["direcciones", "addresses", "stops"];
const ROUTE_DAILY_COLLECTIONS = ["routes", "rutas"];
const ROUTE_LIVE_COLLECTIONS = ["routes", "rutas"];
const LIVE_HIGH_ACCURACY_MAX_METERS = 60;
const TRAIL_MIN_POINT_METERS = 8;
const TRAIL_STROKE_COLOR = "#22d2c5";
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 10000,
};
const EMPTY_AUTH_ACTIONS = Object.freeze({
  hasUser: false,
  canEnableNotifications: false,
  notificationsPending: false,
  notificationsMessage: "",
  logoutPending: false,
  enableNotifications: null,
  logout: null,
});
const toLowerText = (value) =>
  value === null || value === undefined ? "" : value.toString().trim().toLowerCase();

const isMonitorProfile = (profile) => {
  const role = toLowerText(profile?.role);
  const accountType = toLowerText(profile?.accountType);
  if (role.includes("monitor") || accountType.includes("monitor")) {
    return true;
  }
  return (
    role === "monitor" ||
    role === "monitora" ||
    accountType === "monitor" ||
    accountType === "monitora"
  );
};

const parseStoredCoords = (profile) => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_BUS_COORDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const lat = Number(parsed?.lat);
    const lng = Number(parsed?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const storedAtMs = Number(parsed?.updatedAtMs ?? parsed?.at);
    if (!Number.isFinite(storedAtMs)) return null;
    if (Date.now() - storedAtMs > LAST_BUS_COORDS_MAX_AGE_MS) return null;

    const storedRouteId = toLowerText(parsed?.routeId);
    const profileRouteId = toLowerText(getRouteId(profile?.route));
    if (storedRouteId && profileRouteId && storedRouteId !== profileRouteId) {
      return null;
    }
    return { lat, lng };
  } catch (error) {
    return null;
  }
};

const parseStoredMapState = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MAP_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const lat = Number(parsed?.lat);
    const lng = Number(parsed?.lng);
    const zoom = Number(parsed?.zoom);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)) {
      return null;
    }
    if (zoom < 3 || zoom > 22) return null;
    return { lat, lng, zoom };
  } catch (error) {
    return null;
  }
};

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

const firstAddressSegment = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().split(",")[0]?.trim() || "";
};

const getProfileDisplayName = (profile) => {
  if (!profile || typeof profile !== "object") return "";
  const fallbackName = [profile.firstName, profile.lastName]
    .map((value) => (value === null || value === undefined ? "" : value.toString().trim()))
    .filter(Boolean)
    .join(" ");
  const candidates = [
    profile.studentName,
    profile.fullName,
    profile.displayName,
    profile.name,
    fallbackName,
  ];
  return candidates
    .map((value) => (value === null || value === undefined ? "" : value.toString().trim()))
    .find(Boolean);
};

const getProfileRouteLabel = (profile) => {
  const route = profile?.route === null || profile?.route === undefined ? "" : profile.route;
  const text = route.toString().trim();
  return text || "Ruta";
};

const getInstitutionDisplayName = (profile) => {
  if (!profile || typeof profile !== "object") return "";
  const candidates = [
    profile.institutionName,
    profile.schoolName,
    profile.school,
    profile.institution,
  ];
  return candidates
    .map((value) => (value === null || value === undefined ? "" : value.toString().trim()))
    .find(Boolean);
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

let loaderPromise;

function loadGoogleMaps(apiKey) {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.google && window.google.maps) return Promise.resolve(window.google);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    if (window.__initGoogleMaps) {
      // already loading
      return;
    }
    window.__initGoogleMaps = () => resolve(window.google);
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&loading=async&libraries=marker&callback=__initGoogleMaps`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(script);
  });

  return loaderPromise;
}

function HomeContent() {
  const searchParams = useSearchParams();
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const userMarkerRef = useRef(null);
  const accuracyCircleRef = useRef(null);
  const watchIdRef = useRef(null);
  const hasActiveLocationWatchRef = useRef(false);
  const lastLocationRequestAtRef = useRef(0);
  const locationErrorCountRef = useRef(0);
  const locationRetryAfterRef = useRef(0);
  const lastPositionRef = useRef(null);
  const lastUploadRef = useRef(0);
  const profileRef = useRef(null);
  const geocoderRef = useRef(null);
  const schoolMarkerRef = useRef(null);
  const routeMarkersRef = useRef([]);
  const resolvedRouteStopsRef = useRef([]);
  const schoolCoordsRef = useRef(null);
  const schoolAddressRef = useRef(null);
  const completedStopsRef = useRef(new Set());
  const studentPickedUpRef = useRef(false);
  const trailPolylineRef = useRef(null);
  const trailPathRef = useRef([]);
  const routeRefreshRef = useRef({ at: 0, signature: "" });
  const monitorPushSyncRef = useRef({ at: 0, signature: "", inFlight: false });
  const monitorPushWarnRef = useRef({ at: 0, key: "" });
  const liveExcludedBySourceRef = useRef({});
  const liveLocationBySourceRef = useRef({});
  const geocodedStopsRef = useRef(new Map());
  const geocodingStopsRef = useRef(new Map());
  const lastStopAddressRef = useRef(null);
  const lastSchoolAddressRef = useRef(null);
  const stopReadyRef = useRef(false);
  const schoolReadyRef = useRef(false);
  const studentCodeDataRef = useRef(null);
  const studentCodeFetchRef = useRef(false);
  const loadingTimeoutRef = useRef(null);
  const updatingMarkersRef = useRef(false);
  const hasFitRef = useRef(false);
  const [pulse, setPulse] = useState(false);
  const [profile, setProfile] = useState(null);
  const [institutionAddress, setInstitutionAddress] = useState(null);
  const [institutionCoords, setInstitutionCoords] = useState(null);
  const [markersLoading, setMarkersLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [etaDistanceKm, setEtaDistanceKm] = useState(null);
  const [etaMinutes, setEtaMinutes] = useState(null);
  const [etaTitle, setEtaTitle] = useState("Llegada");
  const [lastLocationUpdatedAt, setLastLocationUpdatedAt] = useState(null);
  const [routeStopsByKey, setRouteStopsByKey] = useState({});
  const [dailyStopStatuses, setDailyStopStatuses] = useState({});
  const [liveExcludedStopKeys, setLiveExcludedStopKeys] = useState([]);
  const [locationEnabled, setLocationEnabled] = useState(true);
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [islandExpanded, setIslandExpanded] = useState(false);
  const [routeUsers, setRouteUsers] = useState([]);
  const [authActions, setAuthActions] = useState(EMPTY_AUTH_ACTIONS);
  const [monitorNextStop, setMonitorNextStop] = useState({
    title: "--",
    order: null,
    source: "Firebase + IA",
  });
  const userDocUnsubRef = useRef(null);
  const profileRouteSignature = profile
    ? [
        profile?.route,
        profile?.institutionCode,
        profile?.institutionAddress,
        profile?.institutionLat,
        profile?.institutionLng,
        profile?.stopAddress,
        profile?.stopLat,
        profile?.stopLng,
        profile?.studentCode,
        profile?.role,
        profile?.accountType,
      ]
        .map((value) =>
          value === null || value === undefined ? "" : value.toString().trim()
        )
      .join("|")
    : "";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const locationRaw = window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY);
    const trailRaw = window.localStorage.getItem(TRAIL_ENABLED_STORAGE_KEY);
    setLocationEnabled(locationRaw === null ? true : locationRaw === "1");
    setTrailEnabled(trailRaw === "1");

    const handleStorage = (event) => {
      if (
        event?.key !== LOCATION_ENABLED_STORAGE_KEY &&
        event?.key !== TRAIL_ENABLED_STORAGE_KEY
      ) {
        return;
      }
      const nextLocationRaw = window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY);
      const nextTrailRaw = window.localStorage.getItem(TRAIL_ENABLED_STORAGE_KEY);
      setLocationEnabled(nextLocationRaw === null ? true : nextLocationRaw === "1");
      setTrailEnabled(nextTrailRaw === "1");
    };
    const handleToggle = () => {
      const nextLocationRaw = window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY);
      const nextTrailRaw = window.localStorage.getItem(TRAIL_ENABLED_STORAGE_KEY);
      setLocationEnabled(nextLocationRaw === null ? true : nextLocationRaw === "1");
      setTrailEnabled(nextTrailRaw === "1");
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(LOCATION_TOGGLE_EVENT, handleToggle);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(LOCATION_TOGGLE_EVENT, handleToggle);
    };
  }, []);

  useEffect(() => {
    profileRef.current = profile;
  }, [profileRouteSignature]);

  useEffect(() => {
    schoolCoordsRef.current = institutionCoords;
  }, [institutionCoords]);

  useEffect(() => {
    schoolAddressRef.current = institutionAddress;
  }, [institutionAddress]);

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
  }, [profileRouteSignature]);

  useEffect(() => {
    if (!profile) {
      setIslandExpanded(false);
      setMarkersLoading(false);
      setEtaMinutes(null);
      setEtaDistanceKm(null);
      setEtaTitle("Llegada");
      setLastLocationUpdatedAt(null);
      setDailyStopStatuses({});
      setLiveExcludedStopKeys([]);
      setMonitorNextStop({
        title: "--",
        order: null,
        source: "Firebase + IA",
      });
      liveExcludedBySourceRef.current = {};
      liveLocationBySourceRef.current = {};
      stopReadyRef.current = false;
      schoolReadyRef.current = !SHOW_SCHOOL_MARKER;
      lastStopAddressRef.current = null;
      lastSchoolAddressRef.current = null;
      hasFitRef.current = false;
      resolvedRouteStopsRef.current = [];
      schoolCoordsRef.current = null;
      schoolAddressRef.current = null;
      completedStopsRef.current = new Set();
      studentPickedUpRef.current = false;
      routeRefreshRef.current = { at: 0, signature: "" };
      monitorPushSyncRef.current = { at: 0, signature: "", inFlight: false };
      studentCodeDataRef.current = null;
      studentCodeFetchRef.current = false;
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }
      return;
    }
    stopReadyRef.current = false;
    schoolReadyRef.current = !SHOW_SCHOOL_MARKER;
    lastStopAddressRef.current = null;
    lastSchoolAddressRef.current = null;
    hasFitRef.current = false;
    setIslandExpanded(false);
    setEtaMinutes(null);
    setEtaDistanceKm(null);
    setEtaTitle("Llegada");
    setLastLocationUpdatedAt(null);
    setDailyStopStatuses({});
    setLiveExcludedStopKeys([]);
    setMonitorNextStop({
      title: "--",
      order: null,
      source: "Firebase + IA",
    });
    liveExcludedBySourceRef.current = {};
    liveLocationBySourceRef.current = {};
    resolvedRouteStopsRef.current = [];
    schoolCoordsRef.current = null;
    schoolAddressRef.current = null;
    completedStopsRef.current = new Set();
    studentPickedUpRef.current = false;
    routeRefreshRef.current = { at: 0, signature: "" };
    monitorPushSyncRef.current = { at: 0, signature: "", inFlight: false };
    studentCodeDataRef.current = null;
    studentCodeFetchRef.current = false;
    setMarkersLoading(true);
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
    }
    loadingTimeoutRef.current = setTimeout(() => {
      setMarkersLoading(false);
      loadingTimeoutRef.current = null;
    }, 7000);
  }, [profile]);

  const resolveRouteKey = (currentProfile) =>
    resolveRouteKeyFromStops(currentProfile, routeStopsByKey);

  const activeRouteKey = resolveRouteKey(profile);
  const activeRouteStops = useMemo(() => {
    if (!activeRouteKey) return [];
    const stops = routeStopsByKey[activeRouteKey];
    return Array.isArray(stops) ? stops : [];
  }, [activeRouteKey, routeStopsByKey]);

  const stopOrderByAddress = useMemo(() => {
    const mapped = new Map();
    activeRouteStops.forEach((stop, index) => {
      const order = index + 1;
      const candidates = [
        normalizeMatchText(stop?.address),
        normalizeMatchText(firstAddressSegment(stop?.address)),
        normalizeMatchText(stop?.title),
      ].filter(Boolean);
      candidates.forEach((candidate) => {
        if (!mapped.has(candidate)) {
          mapped.set(candidate, order);
        }
      });
    });
    return mapped;
  }, [activeRouteStops]);

  useEffect(() => {
    if (!profile?.institutionCode) {
      setRouteUsers([]);
      return;
    }

    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("institutionCode", "==", profile.institutionCode));
    const targetRoute = normalizeMatchText(profile?.route);

    const unsubscribe = onSnapshot(
      usersQuery,
      (snapshot) => {
        const users = snapshot.docs
          .map((item) => ({ uid: item.id, ...(item.data() || {}) }))
          .filter((item) => {
            if (!targetRoute) return true;
            return normalizeMatchText(item?.route) === targetRoute;
          });
        setRouteUsers(users);
      },
      () => {
        setRouteUsers([]);
      }
    );

    return () => unsubscribe();
  }, [profile?.institutionCode, profile?.route]);

  const routeStudents = useMemo(
    () =>
      routeUsers.filter((item) => {
        if (isMonitorProfile(item)) return false;
        return Boolean(item?.studentCode || item?.studentName || item?.stopAddress);
      }),
    [routeUsers]
  );

  const routeMonitor = useMemo(
    () => routeUsers.find((item) => isMonitorProfile(item)) || null,
    [routeUsers]
  );

  const monitorDisplayName = getProfileDisplayName(routeMonitor) || "Monitora por confirmar";
  const assignedStopAddress =
    profile?.stopAddress ||
    profile?.studentStopAddress ||
    studentCodeDataRef.current?.stopAddress ||
    "";
  const studentStopOrder =
    stopOrderByAddress.get(normalizeMatchText(assignedStopAddress)) ||
    stopOrderByAddress.get(normalizeMatchText(firstAddressSegment(assignedStopAddress))) ||
    null;

  const routeStudentEntries = useMemo(() => {
    return routeStudents.map((item) => {
      const displayName = getProfileDisplayName(item) || "Estudiante";
      const stopAddress = item?.stopAddress || "";
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
        if (dailyStopStatuses[key]) {
          statusEntry = dailyStopStatuses[key];
          break;
        }
      }

      const picked = statusEntry?.status === STOP_STATUS.BOARDED;
      return {
        uid: item.uid,
        name: displayName,
        stopAddress,
        order,
        picked,
      };
    });
  }, [routeStudents, stopOrderByAddress, dailyStopStatuses]);

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
    getInstitutionDisplayName(routeMonitor) || profileInstitutionName;
  const schoolAddressLabel = firstAddressSegment(
    profile?.institutionAddress ||
      institutionAddress ||
      routeMonitor?.institutionAddress ||
      studentCodeDataRef.current?.institutionAddress
  );
  const monitorSchoolLabel = monitorInstitutionName || schoolAddressLabel || "Colegio";
  const studentRouteSchoolLabel = `${monitorRouteLabel} - ${monitorSchoolLabel}`;
  const monitorRouteSchoolLabel = `${profileRouteLabel} - ${monitorSchoolLabel}`;

  useEffect(() => {
    if (!profile) {
      setDailyStopStatuses({});
      return;
    }

    const routeKey = resolveRouteKey(profile);
    const routeIds = getRouteIdCandidates({
      profile,
      routeKey,
      routeStopsByKey,
    });
    if (!routeIds.length) {
      setDailyStopStatuses({});
      return;
    }

    const dateKey = getServiceDateKey();
    const roots = ROUTE_DAILY_COLLECTIONS;
    const sourceMaps = {};
    const unsubscribers = [];

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
  }, [profileRouteSignature, routeStopsByKey]);

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

  const maybeUploadLocation = async (coords) => {
    try {
      const currentUser = auth.currentUser;
      const currentProfile = profileRef.current;
      if (!currentUser || !currentProfile?.route || !isMonitorProfile(currentProfile)) {
        return;
      }

      const now = Date.now();
      if (now - lastUploadRef.current < MAP_MARKER_REFRESH_INTERVAL_MS) return;
      lastUploadRef.current = now;

      const routeKey = resolveRouteKey(currentProfile);
      const routeIds = getRouteIdCandidates({
        profile: currentProfile,
        routeKey,
        routeStopsByKey,
      });
      if (!routeIds.length) return;

      const writes = [];
      routeIds.forEach((routeId) => {
        ROUTE_LIVE_COLLECTIONS.forEach((rootCollection) => {
          const liveRef = doc(db, rootCollection, routeId, "live", "current");
          writes.push(
            setDoc(
              liveRef,
              {
                uid: currentUser.uid,
                route: currentProfile.route,
                lat: coords.lat,
                lng: coords.lng,
                updatedAtClientMs: now,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            )
          );
        });
      });

      await Promise.allSettled(writes);
    } catch (err) {
      // ignore upload errors to avoid interrupting location updates
    }
  };

  const updateMarker = (google, map, coords, options = {}) => {
    const shouldUpload = options.upload === true;
    const markerUpdatedAtMs = Number(options?.updatedAtMs);
    const markerUpdatedAt = Number.isFinite(markerUpdatedAtMs)
      ? markerUpdatedAtMs
      : Date.now();
    setLastLocationUpdatedAt(markerUpdatedAt);
    lastPositionRef.current = coords;

    if (!userMarkerRef.current) {
      userMarkerRef.current = createMarker(google, {
        position: coords,
        map,
        title: "Bus escolar",
        kind: "user",
      });
    } else {
      setMarkerPosition(userMarkerRef.current, coords);
    }

    appendTrailPoint(google, map, coords);

    if (shouldUpload) {
      void maybeUploadLocation(coords);
    }

    try {
      if (typeof window !== "undefined") {
        const currentProfile = profileRef.current;
        window.localStorage.setItem(
          LAST_BUS_COORDS_STORAGE_KEY,
          JSON.stringify({
            lat: coords.lat,
            lng: coords.lng,
            routeId: getRouteId(currentProfile?.route),
            updatedAtMs: Date.now(),
          })
        );
      }
    } catch (error) {
      // ignore storage errors
    }
  };

  const parseCoord = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
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
    void options;
    void timeoutMs;

    if (!Array.isArray(points) || points.length < 2) {
      return { ok: false, data: {} };
    }

    const normalized = points.map((point) => {
      const lat = Number(point?.lat);
      const lng = Number(point?.lng);
      return {
        lat,
        lng,
        valid: Number.isFinite(lat) && Number.isFinite(lng),
      };
    });

    if (normalized.some((point) => !point.valid)) {
      return { ok: false, data: {} };
    }

    const legs = [];
    let distanceMetersTotal = 0;

    for (let index = 0; index < normalized.length - 1; index += 1) {
      const segmentDistance = distanceMetersBetween(normalized[index], normalized[index + 1]);
      const safeDistance =
        typeof segmentDistance === "number" && Number.isFinite(segmentDistance)
          ? Math.max(0, segmentDistance)
          : 0;
      distanceMetersTotal += safeDistance;
      const durationSeconds = Math.max(
        1,
        Math.round(((safeDistance / 1000) / ETA_ESTIMATED_SPEED_KMH) * 3600)
      );
      legs.push({
        distanceMeters: Math.round(safeDistance),
        duration: `${durationSeconds}s`,
      });
    }

    const totalDurationSeconds = Math.max(
      1,
      Math.round(((distanceMetersTotal / 1000) / ETA_ESTIMATED_SPEED_KMH) * 3600)
    );

    return {
      ok: true,
      data: {
        distanceMeters: Math.round(distanceMetersTotal),
        duration: `${totalDurationSeconds}s`,
        legs,
        optimizedIntermediateWaypointIndex: [],
        source: "local_estimate",
      },
    };
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

  const clearTrailPolyline = () => {
    if (trailPolylineRef.current) {
      trailPolylineRef.current.setMap(null);
      trailPolylineRef.current = null;
    }
    trailPathRef.current = [];
  };

  const ensureTrailPolyline = (google, map) => {
    if (!trailPolylineRef.current) {
      trailPolylineRef.current = new google.maps.Polyline({
        map,
        path: [],
        strokeColor: TRAIL_STROKE_COLOR,
        strokeOpacity: 0.95,
        strokeWeight: 7,
        geodesic: true,
        zIndex: 4,
      });
      return trailPolylineRef.current;
    }

    if (typeof trailPolylineRef.current.setMap === "function") {
      trailPolylineRef.current.setMap(map);
    }
    return trailPolylineRef.current;
  };

  const appendTrailPoint = (google, map, coords) => {
    if (!trailEnabled || !locationEnabled || !isMonitorProfile(profileRef.current)) return;

    const lat = Number(coords?.lat);
    const lng = Number(coords?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const nextPoint = { lat, lng };
    const path = trailPathRef.current;
    const previousPoint = path.length ? path[path.length - 1] : null;
    const jumpMeters = distanceMetersBetween(previousPoint, nextPoint);
    if (
      previousPoint &&
      typeof jumpMeters === "number" &&
      jumpMeters < TRAIL_MIN_POINT_METERS
    ) {
      return;
    }

    path.push(nextPoint);
    const polyline = ensureTrailPolyline(google, map);
    polyline.setPath(path);
  };

  const stopLocationWatch = () => {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    hasActiveLocationWatchRef.current = false;
  };

  const requestLocation = (options = {}) => {
    const force = Boolean(options?.force);
    const map = mapInstanceRef.current;
    if (!map || !window.google || !("geolocation" in navigator)) return;

    const now = Date.now();
    if (!force && now < locationRetryAfterRef.current) return;
    if (!force && hasActiveLocationWatchRef.current) return;
    if (!force && now - lastLocationRequestAtRef.current < MAP_MARKER_REFRESH_INTERVAL_MS) return;
    lastLocationRequestAtRef.current = now;

    if (force) {
      stopLocationWatch();
    } else if (watchIdRef.current !== null) {
      hasActiveLocationWatchRef.current = true;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        locationErrorCountRef.current = 0;
        locationRetryAfterRef.current = 0;
        const coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        updateMarker(window.google, map, coords);
        void updateEta(coords);
        if (!accuracyCircleRef.current) {
          accuracyCircleRef.current = new window.google.maps.Circle({
            map,
            center: coords,
            radius: position.coords.accuracy || 0,
            fillColor: "#1a73e8",
            fillOpacity: 0.15,
            strokeColor: "#1a73e8",
            strokeOpacity: 0.3,
            strokeWeight: 1,
          });
        } else {
          accuracyCircleRef.current.setCenter(coords);
          accuracyCircleRef.current.setRadius(position.coords.accuracy || 0);
        }
      },
      (error) => {
        if (error?.code === 1) {
          // Permission denied: avoid retry storms.
          stopLocationWatch();
          locationRetryAfterRef.current = Date.now() + 5 * 60 * 1000;
          return;
        }
      },
      GEOLOCATION_OPTIONS
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        hasActiveLocationWatchRef.current = true;
        locationErrorCountRef.current = 0;
        locationRetryAfterRef.current = 0;
        const coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        updateMarker(window.google, map, coords);
        void updateEta(coords);
        if (!accuracyCircleRef.current) {
          accuracyCircleRef.current = new window.google.maps.Circle({
            map,
            center: coords,
            radius: position.coords.accuracy || 0,
            fillColor: "#1a73e8",
            fillOpacity: 0.15,
            strokeColor: "#1a73e8",
            strokeOpacity: 0.3,
            strokeWeight: 1,
          });
        } else {
          accuracyCircleRef.current.setCenter(coords);
          accuracyCircleRef.current.setRadius(position.coords.accuracy || 0);
        }
      },
      (error) => {
        locationErrorCountRef.current += 1;
        if (error?.code === 1) {
          stopLocationWatch();
          locationRetryAfterRef.current = Date.now() + 5 * 60 * 1000;
          return;
        }
        if (locationErrorCountRef.current >= 3) {
          stopLocationWatch();
          locationRetryAfterRef.current = Date.now() + 30 * 1000;
        }
      },
      GEOLOCATION_OPTIONS
    );
    hasActiveLocationWatchRef.current = true;
  };

  const getDirectRouteMetrics = async (from, to) => {
    if (!from || !to) {
      return { distanceMeters: null, durationSeconds: null };
    }
    const fallbackDistance = distanceMetersBetween(from, to);
    try {
      const { ok, data } = await fetchRoutesData([
        { lat: from.lat, lng: from.lng },
        { lat: to.lat, lng: to.lng },
      ]);
      if (!ok) {
        return { distanceMeters: fallbackDistance, durationSeconds: null };
      }

      const distanceMeters =
        typeof data?.distanceMeters === "number" ? data.distanceMeters : fallbackDistance;
      const durationSeconds = parseDurationSeconds(data?.duration);
      return { distanceMeters, durationSeconds };
    } catch (error) {
      return { distanceMeters: fallbackDistance, durationSeconds: null };
    }
  };

  const setEtaMetrics = ({ title, distanceMeters, durationSeconds }) => {
    setEtaTitle(title || "Llegada");
    if (typeof distanceMeters === "number" && Number.isFinite(distanceMeters)) {
      const km = distanceMeters / 1000;
      setEtaDistanceKm(km.toFixed(1));
      if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
        setEtaMinutes(Math.max(1, Math.round(durationSeconds / 60)));
      } else {
        setEtaMinutes(Math.max(1, Math.round((km / 24) * 60)));
      }
      return;
    }
    setEtaDistanceKm(null);
    setEtaMinutes(null);
  };

  const syncMonitorPushEta = async ({ coords, orderedPending, legs }) => {
    if (!profile || !isMonitorProfile(profile) || !Array.isArray(orderedPending)) return;
    if (!orderedPending.length) return;

    const routeKey = resolveRouteKey(profile);
    const routeNameFromKey = routeKey ? routeKey.split(":").slice(1).join(":") : null;
    const routeId = getRouteId(routeNameFromKey || profile.route);
    if (!routeId) return;

    const stops = orderedPending.map((stop, index) => {
      const stopKey = normalizeStopKey(stop) || stop.id || `paradero-${index + 1}`;
      const statusData = resolveStopStatusEntry(dailyStopStatuses, {
        ...stop,
        key: stopKey,
      });
      const legMetrics = sumLegs(legs, 0, index);
      const minutes =
        typeof legMetrics.durationSeconds === "number"
          ? Math.max(1, Math.round(legMetrics.durationSeconds / 60))
          : null;
      const statusValue = statusData?.status || null;

      return {
        key: stopKey,
        title: stop.title || `Paradero ${index + 1}`,
        address: stop.address || null,
        order: index,
        minutes,
        status: statusValue,
        excluded: isStopAbsentStatus(statusValue),
      };
    });

    const roundedCoords = `${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
    const signature = `${routeId}:${roundedCoords}:${stops
      .map((item) => `${item.key}:${item.minutes ?? "na"}:${item.status ?? "none"}`)
      .join("|")}`;
    const now = Date.now();
    if (
      monitorPushSyncRef.current.inFlight ||
      (monitorPushSyncRef.current.signature === signature &&
        now - monitorPushSyncRef.current.at < 25000)
    ) {
      return;
    }

    monitorPushSyncRef.current = {
      at: now,
      signature,
      inFlight: true,
    };

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
          eventType: "eta_update",
          routeId,
          route: profile.route || null,
          institutionCode: profile.institutionCode || null,
          busCoords: coords,
          stops,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Monitor ETA push sync failed", payload);
        return;
      }
      const sent = Number(payload?.sent || 0);
      const diagnostics = payload?.diagnostics || {};
      const warnKey = JSON.stringify({
        noToken: Number(diagnostics?.noToken || 0),
        failedSend: Number(diagnostics?.failedSend || 0),
        attempted: Number(diagnostics?.attempted || 0),
      });
      const shouldWarn =
        sent === 0 &&
        (Number(diagnostics?.noToken || 0) > 0 ||
          Number(diagnostics?.failedSend || 0) > 0 ||
          Number(diagnostics?.attempted || 0) > 0);
      if (shouldWarn) {
        const nowWarn = Date.now();
        if (
          monitorPushWarnRef.current.key !== warnKey ||
          nowWarn - monitorPushWarnRef.current.at > 120000
        ) {
          monitorPushWarnRef.current = { at: nowWarn, key: warnKey };
          console.warn("Monitor ETA push sent 0 notifications", payload);
        }
      }
    } catch (error) {
      console.error("Monitor ETA push sync request failed", error);
    } finally {
      monitorPushSyncRef.current = {
        ...monitorPushSyncRef.current,
        inFlight: false,
      };
    }
  };

  const resolveStudentStopCoords = async (currentProfile) => {
    if (!currentProfile) return null;
    const stopLat = parseCoord(currentProfile.stopLat);
    const stopLng = parseCoord(currentProfile.stopLng);
    if (stopLat !== null && stopLng !== null) {
      return { lat: stopLat, lng: stopLng };
    }

    const stopAddress = toLowerText(currentProfile.stopAddress)
      ? currentProfile.stopAddress.toString().trim()
      : "";
    if (!stopAddress) return null;
    const query = stopAddress.includes("Bogotá")
      ? stopAddress
      : `${stopAddress}, Bogotá, Colombia`;
    return geocodeAddressToCoords(query);
  };

  const findStopByAddressOrCoords = (stops, address, coords) => {
    const normalizedAddress = toLowerText(address);
    const byAddress = normalizedAddress
      ? stops.find(
          (stop) =>
            toLowerText(stop?.address) === normalizedAddress ||
            toLowerText(stop?.title) === normalizedAddress
        )
      : null;
    if (byAddress) return byAddress;
    if (!coords) return null;
    return (
      stops.find((stop) => {
        const distance = distanceMetersBetween(stop?.coords, coords);
        return typeof distance === "number" && distance <= STOP_REACHED_METERS;
      }) || null
    );
  };

  const updateEta = async (coords, options = {}) => {
    if (!coords || !profile) return;

    const resolvedStops = Array.isArray(resolvedRouteStopsRef.current)
      ? resolvedRouteStopsRef.current
      : [];
    const schoolCoords = schoolCoordsRef.current;
    const schoolAddress = schoolAddressRef.current;
    const routeKey = resolveRouteKey(profile) || "route";
    const rounded = `${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
    const signature = `${routeKey}:${rounded}:${resolvedStops.length}:${
      schoolCoords ? `${schoolCoords.lat.toFixed(4)},${schoolCoords.lng.toFixed(4)}` : "no-school"
    }`;

    const now = Date.now();
    if (
      !options?.force &&
      routeRefreshRef.current.signature === signature &&
      now - routeRefreshRef.current.at < ROUTE_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    routeRefreshRef.current = { at: now, signature };

    resolvedStops.forEach((stop) => {
      const distance = distanceMetersBetween(coords, stop.coords);
      if (typeof distance === "number" && distance <= STOP_REACHED_METERS) {
        completedStopsRef.current.add(stop.id);
      }
    });
    const pendingStops = resolvedStops.filter(
      (stop) => !completedStopsRef.current.has(stop.id)
    );

    const targetSchool = schoolCoords
      ? schoolCoords
      : schoolAddress
        ? await geocodeAddressToCoords(schoolAddress)
        : null;

    if (!pendingStops.length && !targetSchool) {
      setMonitorNextStop({
        title: "--",
        order: null,
        source: "Firebase + IA",
      });
      setEtaMetrics({ title: "Llegada", distanceMeters: null, durationSeconds: null });
      return;
    }

    const points = [{ lat: coords.lat, lng: coords.lng }];
    pendingStops.forEach((stop) => {
      points.push({ lat: stop.coords.lat, lng: stop.coords.lng });
    });
    if (targetSchool) {
      points.push({ lat: targetSchool.lat, lng: targetSchool.lng });
    }

    let routeData = null;
    if (points.length >= 2) {
      try {
        const { ok, data } = await fetchRoutesData(points, {
          optimizeWaypoints: Boolean(targetSchool && pendingStops.length > 1),
        });
        if (ok) {
          routeData = data;
        }
      } catch (error) {
        routeData = null;
      }
    }

    const optimizedIndexes = Array.isArray(routeData?.optimizedIntermediateWaypointIndex)
      ? routeData.optimizedIntermediateWaypointIndex
      : [];
    const orderedPending =
      targetSchool && optimizedIndexes.length === pendingStops.length
        ? optimizedIndexes
            .map((index) => pendingStops[index])
            .filter(Boolean)
        : pendingStops;
    const legs = Array.isArray(routeData?.legs) ? routeData.legs : [];

    if (isMonitorProfile(profile)) {
      if (orderedPending.length) {
        const nextStop = orderedPending[0] || null;
        const nextOrder =
          typeof nextStop?.sourceIndex === "number" ? nextStop.sourceIndex + 1 : null;
        setMonitorNextStop({
          title:
            nextStop?.title ||
            firstAddressSegment(nextStop?.address) ||
            nextStop?.address ||
            "--",
          order: nextOrder,
          source: "Firebase + IA",
        });
        void syncMonitorPushEta({ coords, orderedPending, legs });
        const firstLeg = sumLegs(legs, 0, 0);
        let distanceMeters = firstLeg.distanceMeters;
        let durationSeconds = firstLeg.durationSeconds;
        if (distanceMeters === null) {
          const direct = await getDirectRouteMetrics(coords, orderedPending[0].coords);
          distanceMeters = direct.distanceMeters;
          durationSeconds = direct.durationSeconds;
        }
        setEtaMetrics({
          title: "Siguiente paradero",
          distanceMeters,
          durationSeconds,
        });
        return;
      }

      if (targetSchool) {
        setMonitorNextStop({
          title: "Colegio",
          order: null,
          source: "Firebase + IA",
        });
        const toSchool = await getDirectRouteMetrics(coords, targetSchool);
        setEtaMetrics({
          title: "Llegada al colegio",
          distanceMeters: toSchool.distanceMeters,
          durationSeconds: toSchool.durationSeconds,
        });
        return;
      }

      setMonitorNextStop({
        title: "--",
        order: null,
        source: "Firebase + IA",
      });
      setEtaMetrics({ title: "Llegada", distanceMeters: null, durationSeconds: null });
      return;
    }

    const studentCoords = await resolveStudentStopCoords(profile);
    const studentStop = findStopByAddressOrCoords(
      resolvedStops,
      profile.stopAddress,
      studentCoords
    );
    if (studentStop) {
      const distanceToStudent = distanceMetersBetween(coords, studentStop.coords);
      if (typeof distanceToStudent === "number" && distanceToStudent <= STOP_REACHED_METERS) {
        completedStopsRef.current.add(studentStop.id);
      }
    }

    if (studentCoords) {
      const distanceToOwnStop = distanceMetersBetween(coords, studentCoords);
      if (
        typeof distanceToOwnStop === "number" &&
        distanceToOwnStop <= STOP_REACHED_METERS
      ) {
        studentPickedUpRef.current = true;
      }
    }

    const isPickedUp =
      studentPickedUpRef.current ||
      (studentStop ? completedStopsRef.current.has(studentStop.id) : false);
    if (isPickedUp) {
      studentPickedUpRef.current = true;
    }
    if (!isPickedUp) {
      const studentIndex = orderedPending.findIndex(
        (stop) => stop.id === studentStop?.id
      );
      if (studentIndex >= 0) {
        const etaToStudent = sumLegs(legs, 0, studentIndex);
        setEtaMetrics({
          title: "Llegada a tu paradero",
          distanceMeters: etaToStudent.distanceMeters,
          durationSeconds: etaToStudent.durationSeconds,
        });
        return;
      }

      const directStudent = await getDirectRouteMetrics(coords, studentCoords);
      setEtaMetrics({
        title: "Llegada a tu paradero",
        distanceMeters: directStudent.distanceMeters,
        durationSeconds: directStudent.durationSeconds,
      });
      return;
    }

    if (targetSchool) {
      if (legs.length) {
        const toSchool = sumLegs(legs, 0, legs.length - 1);
        setEtaMetrics({
          title: "Llegada al colegio",
          distanceMeters: toSchool.distanceMeters,
          durationSeconds: toSchool.durationSeconds,
        });
        return;
      }

      const directSchool = await getDirectRouteMetrics(coords, targetSchool);
      setEtaMetrics({
        title: "Llegada al colegio",
        distanceMeters: directSchool.distanceMeters,
        durationSeconds: directSchool.durationSeconds,
      });
      return;
    }

    setEtaMetrics({ title: "Llegada", distanceMeters: null, durationSeconds: null });
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        if (userDocUnsubRef.current) {
          userDocUnsubRef.current();
          userDocUnsubRef.current = null;
        }
        setProfile(null);
        setInstitutionAddress(null);
        setInstitutionCoords(null);
        return;
      }

      const userRef = doc(db, "users", currentUser.uid);
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
      }

      userDocUnsubRef.current = onSnapshot(
        userRef,
        async (snap) => {
          let data = snap.exists() ? snap.data() : null;
          if (data?.studentCode && (!data.stopAddress || !data.institutionCode)) {
            const codeRef = doc(db, "studentCodes", data.studentCode);
            const codeSnap = await getDoc(codeRef);
            if (codeSnap.exists()) {
              const codeData = codeSnap.data();
              const merged = {
                ...data,
                stopAddress: data.stopAddress || codeData.stopAddress || null,
                institutionCode:
                  data.institutionCode || codeData.institutionCode || null,
                institutionName:
                  data.institutionName || codeData.institutionName || null,
                institutionAddress:
                  data.institutionAddress || codeData.institutionAddress || null,
                route: data.route || codeData.route || null,
                studentName: data.studentName || codeData.studentName || null,
                stopLat: data.stopLat || codeData.stopLat || null,
                stopLng: data.stopLng || codeData.stopLng || null,
                institutionLat:
                  data.institutionLat || codeData.institutionLat || null,
                institutionLng:
                  data.institutionLng || codeData.institutionLng || null,
              };
              data = merged;
              await setDoc(userRef, merged, { merge: true });
            }
          }

          setProfile(data);

          if (data?.institutionCode) {
            const instRef = doc(db, "institutions", data.institutionCode);
            const instSnap = await getDoc(instRef);
            if (instSnap.exists()) {
              const instData = instSnap.data();
              const lat = parseCoord(instData.lat);
              const lng = parseCoord(instData.lng);
              setInstitutionAddress(
                instData.address || data.institutionAddress || null
              );
              if (lat !== null && lng !== null) {
                setInstitutionCoords({ lat, lng });
              } else {
                setInstitutionCoords(null);
              }
            } else {
              setInstitutionAddress(null);
              setInstitutionCoords(null);
            }
          } else {
            setInstitutionAddress(null);
            setInstitutionCoords(null);
          }
        },
        () => {
          // ignore
        }
      );
    });

    return () => {
      unsubscribe();
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }
    };
  }, []);

  const geocodeAddress = async (google, address) => {
    const apiCoords = await geocodeAddressToCoords(address);
    if (apiCoords) {
      return new google.maps.LatLng(apiCoords.lat, apiCoords.lng);
    }

    if (!geocoderRef.current) {
      geocoderRef.current = new google.maps.Geocoder();
    }
    return new Promise((resolve) => {
      geocoderRef.current.geocode({ address }, (results, status) => {
        if (status === "OK" && results && results[0]) {
          if (typeof window !== "undefined") {
            const loc = results[0].geometry.location;
            window.localStorage.setItem(
              `geocode:${address}`,
              JSON.stringify({ lat: loc.lat(), lng: loc.lng() })
            );
          }
          resolve(results[0].geometry.location);
        } else {
          resolve(null);
        }
      });
    });
  };

  const createMarker = (google, { position, map, title, kind }) => {
    const isBusMarker = kind === "user";
    const isSchoolMarker = kind === "school";
    const markerZIndex = isBusMarker ? 9999 : 120;
    const AdvancedMarker = google.maps?.marker?.AdvancedMarkerElement;
    if (AdvancedMarker && map) {
      try {
        const content = document.createElement("div");
        if (isBusMarker) {
          content.className = "marker-bus-plain";
          const image = document.createElement("img");
          image.src = "/icons/bus.png";
          image.alt = "";
          image.className = "marker-bus-image-plain";
          image.decoding = "async";
          image.loading = "eager";
          content.appendChild(image);
        } else {
          content.className = "marker-pin-wrap";
          const pinImage = document.createElement("img");
          pinImage.alt = "";
          pinImage.className = "marker-pin-image";
          pinImage.decoding = "async";
          pinImage.loading = "eager";
          pinImage.src = isSchoolMarker
            ? "https://maps.google.com/mapfiles/ms/icons/green-dot.png"
            : "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
          content.appendChild(pinImage);
        }
        return new AdvancedMarker({
          map,
          position,
          title,
          content,
          zIndex: markerZIndex,
        });
      } catch (err) {
        // Fall back to classic marker when advanced markers fail by environment.
      }
    }

    const icon =
      isBusMarker
        ? {
            url: "/icons/bus.png",
            scaledSize: new google.maps.Size(64, 64),
            anchor: new google.maps.Point(32, 32),
          }
        : isSchoolMarker
          ? {
              url: "https://maps.google.com/mapfiles/ms/icons/green-dot.png",
            }
        : {
            url: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
          };

    return new google.maps.Marker({
      position,
      map,
      title,
      icon,
      zIndex: markerZIndex,
    });
  };

  const setMarkerMap = (marker, map) => {
    if (!marker) return;
    if ("map" in marker) {
      marker.map = map;
    } else if (typeof marker.setMap === "function") {
      marker.setMap(map);
    }
  };

  const setMarkerPosition = (marker, position) => {
    if (!marker) return;
    if ("position" in marker) {
      marker.position = position;
    } else if (typeof marker.setPosition === "function") {
      marker.setPosition(position);
    }
  };

  const updateRouteMarkers = async () => {
    const map = mapInstanceRef.current;
    if (!map || !window.google || !profile || updatingMarkersRef.current) {
      return;
    }
    updatingMarkersRef.current = true;

    try {
      const google = window.google;
      if (
        profile.studentCode &&
        !studentCodeDataRef.current &&
        !studentCodeFetchRef.current
      ) {
        studentCodeFetchRef.current = true;
        try {
          const codeRef = doc(db, "studentCodes", profile.studentCode);
          const codeSnap = await getDoc(codeRef);
          if (codeSnap.exists()) {
            studentCodeDataRef.current = codeSnap.data();
          }
        } catch (err) {
          studentCodeDataRef.current = null;
        } finally {
          studentCodeFetchRef.current = false;
        }
      }

      const stopAddress =
        profile.stopAddress || studentCodeDataRef.current?.stopAddress || null;
      const stopStatusMap = dailyStopStatuses || {};
      const schoolAddress =
        institutionAddress ||
        profile.institutionAddress ||
        studentCodeDataRef.current?.institutionAddress ||
        null;
      const stopLat = parseCoord(
        profile.stopLat ?? studentCodeDataRef.current?.stopLat
      );
      const stopLng = parseCoord(
        profile.stopLng ?? studentCodeDataRef.current?.stopLng
      );
      const stopCoords =
        stopLat !== null && stopLng !== null
          ? new google.maps.LatLng(stopLat, stopLng)
          : null;
      if (!stopCoords && stopAddress) {
        // ignore
      }
      const schoolLat = parseCoord(
        institutionCoords?.lat ??
          profile.institutionLat ??
          studentCodeDataRef.current?.institutionLat
      );
      const schoolLng = parseCoord(
        institutionCoords?.lng ??
          profile.institutionLng ??
          studentCodeDataRef.current?.institutionLng
      );
      let schoolCoords =
        schoolLat !== null && schoolLng !== null
          ? new google.maps.LatLng(schoolLat, schoolLng)
          : null;
      if (!schoolCoords && schoolAddress) {
        const query = schoolAddress.includes("Bogotá")
          ? schoolAddress
          : `${schoolAddress}, Bogotá, Colombia`;
        schoolCoords = await geocodeAddress(google, query);
      }
      schoolCoordsRef.current = schoolCoords
        ? { lat: schoolCoords.lat(), lng: schoolCoords.lng() }
        : null;
      schoolAddressRef.current = schoolAddress;

      const updateLoadingState = () => {
        const needsStop = Boolean(stopCoords || stopAddress);
        const stopReady = !needsStop || stopReadyRef.current;
        if (stopReady) {
          setMarkersLoading(false);
          if (loadingTimeoutRef.current) {
            clearTimeout(loadingTimeoutRef.current);
            loadingTimeoutRef.current = null;
          }

          if (!hasFitRef.current) {
            const bounds = new google.maps.LatLngBounds();
            if (routeMarkersRef.current.length) {
              routeMarkersRef.current.forEach((marker) => {
                if (marker?.position) {
                  bounds.extend(marker.position);
                } else if (typeof marker.getPosition === "function") {
                  bounds.extend(marker.getPosition());
                }
              });
            }
            if (lastPositionRef.current) {
              bounds.extend(lastPositionRef.current);
            }
            if (!bounds.isEmpty()) {
              map.fitBounds(bounds, 60);
              const listener = google.maps.event.addListenerOnce(
                map,
                "idle",
                () => {
                  if (map.getZoom() > MAX_FIT_ZOOM) {
                    map.setZoom(MAX_FIT_ZOOM);
                  }
                }
              );
              if (!listener) {
                if (map.getZoom() > MAX_FIT_ZOOM) {
                  map.setZoom(MAX_FIT_ZOOM);
                }
              }
              hasFitRef.current = true;
            }
          }
        }
      };

      const routeKey = resolveRouteKey(profile);
      const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
      const liveExcludedSet = new Set(
        liveExcludedStopKeys.map((value) =>
          value === null || value === undefined
            ? ""
            : value.toString().trim().toLowerCase()
        )
      );
      // no logging
      const stopCandidates = [];
      const ownAddressKey = normalizeStopKey({
        address: stopAddress,
        title: "Paradero",
      });
      const matchedRouteStop = (routeStops || []).find(
        (item) =>
          toLowerText(item?.address) &&
          toLowerText(item?.address) === toLowerText(stopAddress)
      );
      const ownStopKey = normalizeStopKey(matchedRouteStop) || ownAddressKey;
      const ownStopStatus =
        resolveStopStatusEntry(stopStatusMap, {
          ...(matchedRouteStop || {}),
          key: ownStopKey,
          address: stopAddress,
          title: "Paradero",
        })?.status || null;
      const ownStopIsLiveExcluded = ownStopKey
        ? liveExcludedSet.has(ownStopKey.toLowerCase())
        : false;
      const ownStopIsAbsent = isStopAbsentStatus(ownStopStatus) || ownStopIsLiveExcluded;
      if (stopCoords) {
        if (!ownStopIsAbsent) {
          stopCandidates.push({
            id: ownStopKey || "student-stop",
            title: "Paradero",
            address: stopAddress,
            coords: stopCoords,
          });
        }
      } else if (stopAddress) {
        if (!ownStopIsAbsent) {
          stopCandidates.push({
            id: ownStopKey || "student-stop",
            title: "Paradero",
            address: stopAddress,
          });
        }
      }

      if (routeStops?.length) {
        routeStops.forEach((stop, index) => {
          const stopKey = normalizeStopKey(stop);
          if (stopKey && liveExcludedSet.has(stopKey.toLowerCase())) return;
          const stopStatus = resolveStopStatusEntry(stopStatusMap, {
            ...stop,
            key: stopKey,
          })?.status;
          if (isStopAbsentStatus(stopStatus)) return;
          stopCandidates.push({
            id: stopKey || stop.id || `paradero-${index + 1}`,
            title: stop.title || `Paradero ${index + 1}`,
            address: stop.address || null,
            coords: stop.coords
              ? new google.maps.LatLng(stop.coords.lat, stop.coords.lng)
              : null,
          });
        });
      }

      const coordsList = [];
      for (const candidate of stopCandidates) {
        if (candidate.coords) {
          coordsList.push({
            id: candidate.id || candidate.title,
            coords: candidate.coords,
            title: candidate.title,
            address: candidate.address || null,
          });
          continue;
        }
        if (candidate.address) {
          const query = candidate.address.includes("Bogotá")
            ? candidate.address
            : `${candidate.address}, Bogotá, Colombia`;
          const coords = await geocodeAddress(google, query);
          if (coords) {
            coordsList.push({
              id: candidate.id || candidate.title,
              coords,
              title: candidate.title,
              address: candidate.address,
            });
          }
        }
      }

      if (coordsList.length) {
        const uniqueById = new Map();
        coordsList.forEach((item) => {
          const key =
            item.address?.toLowerCase() ||
            `${item.coords.lat().toFixed(6)},${item.coords.lng().toFixed(6)}`;
          if (!uniqueById.has(key)) {
            uniqueById.set(key, item);
          }
        });
        const resolvedList = Array.from(uniqueById.values());
        resolvedRouteStopsRef.current = resolvedList.map((item, index) => ({
          id: item.id || `paradero-${index + 1}`,
          title: item.title || `Paradero ${index + 1}`,
          address: item.address || null,
          coords: {
            lat: item.coords.lat(),
            lng: item.coords.lng(),
          },
        }));

        routeMarkersRef.current.forEach((marker) => setMarkerMap(marker, null));
        routeMarkersRef.current = resolvedList.map((item) => {
          return createMarker(google, {
            position: item.coords,
            map,
            title: item.title,
            kind: "stop",
          });
        });

        if (!lastPositionRef.current && resolvedList.length && !isMonitorProfile(profile)) {
          const firstCoords = {
            lat: resolvedList[0].coords.lat(),
            lng: resolvedList[0].coords.lng(),
          };
          updateMarker(google, map, firstCoords, { upload: false });
          void updateEta(firstCoords, { force: true });
        }

        if (SHOW_SCHOOL_MARKER && schoolCoords) {
          if (!schoolMarkerRef.current) {
            schoolMarkerRef.current = createMarker(google, {
              position: schoolCoords,
              map,
              title: "Colegio",
              kind: "school",
            });
          } else {
            setMarkerPosition(schoolMarkerRef.current, schoolCoords);
            setMarkerMap(schoolMarkerRef.current, map);
          }
        } else if (schoolMarkerRef.current) {
          setMarkerMap(schoolMarkerRef.current, null);
        }

        stopReadyRef.current = true;
        updateLoadingState();

        if (!hasFitRef.current) {
          const bounds = new google.maps.LatLngBounds();
          resolvedList.forEach((item) => bounds.extend(item.coords));
          if (schoolCoords) {
            bounds.extend(schoolCoords);
          }
          if (lastPositionRef.current) {
            bounds.extend(lastPositionRef.current);
          }
          if (!bounds.isEmpty()) {
            map.fitBounds(bounds, 60);
            hasFitRef.current = true;
          }
        }
      }
      if (!coordsList.length) {
        routeMarkersRef.current.forEach((marker) => setMarkerMap(marker, null));
        routeMarkersRef.current = [];
        resolvedRouteStopsRef.current = [];
        if (schoolMarkerRef.current) {
          setMarkerMap(schoolMarkerRef.current, null);
        }
      }

      if (lastPositionRef.current) {
        void updateEta(lastPositionRef.current, { force: true });
      }
    } finally {
      updatingMarkersRef.current = false;
    }
  };

  useEffect(() => {
    const targetStop = searchParams?.get("stop");
    if (!targetStop || !profile || !mapReady) return;
    const routeKey = resolveRouteKey(profile);
    const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
    if (!routeStops?.length) return;
    const stop = routeStops.find(
      (item) => item.title.toLowerCase() === targetStop.toLowerCase()
    );
    if (!stop) return;

    const map = mapInstanceRef.current;
    if (!map || !window.google) return;
    const google = window.google;

    const centerOnStop = async () => {
      let coords = null;
      if (stop.coords) {
        coords = new google.maps.LatLng(stop.coords.lat, stop.coords.lng);
      } else if (stop.address) {
        coords = await geocodeAddress(google, stop.address);
      }
      if (!coords) return;
      map.setZoom(17);
      map.panTo(coords);
    };

    void centerOnStop();
  }, [searchParams, profile, mapReady, routeStopsByKey]);

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return;

    let isMounted = true;

    loadGoogleMaps(apiKey)
      .then((google) => {
        if (!google || !mapRef.current || !isMounted) return;
        if (mapInstanceRef.current) return;

        const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";
        const storedMapState = parseStoredMapState();
        const map = new google.maps.Map(mapRef.current, {
          center: storedMapState
            ? { lat: storedMapState.lat, lng: storedMapState.lng }
            : BOGOTA,
          zoom: storedMapState?.zoom ?? ZOOM_NEAR,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          mapId: mapId || undefined,
        });
        if (storedMapState) {
          hasFitRef.current = true;
        }

        mapInstanceRef.current = map;
        setMapReady(true);

        map.addListener("idle", () => {
          try {
            const center = map.getCenter();
            if (!center) return;
            const payload = {
              lat: center.lat(),
              lng: center.lng(),
              zoom: map.getZoom(),
            };
            window.localStorage.setItem(MAP_STATE_STORAGE_KEY, JSON.stringify(payload));
          } catch (err) {
            // ignore
          }
        });
      })
      .catch(() => null);

    return () => {
      isMounted = false;
      stopLocationWatch();
      clearTrailPolyline();
    };
  }, []);

  useEffect(() => {
    if (!profile || !mapReady) return;
    updateRouteMarkers();
    if (mapInstanceRef.current && window.google?.maps) {
      window.google.maps.event.trigger(mapInstanceRef.current, "resize");
    }
  }, [profile, mapReady, routeStopsByKey, dailyStopStatuses, liveExcludedStopKeys]);

  useEffect(() => {
    if (!profile || !mapReady) return;
    // GPS publishing now runs centrally in LiveLocationTicker to avoid
    // monitor/student drift from duplicate location writers.
    stopLocationWatch();
  }, [profile, mapReady, locationEnabled]);

  useEffect(() => {
    if (!profile || !mapReady || !window.google) return;
    if (isMonitorProfile(profile)) return;
    const map = mapInstanceRef.current;
    if (!map || lastPositionRef.current) return;

    const cached = parseStoredCoords(profile);
    if (!cached) return;
    updateMarker(window.google, map, cached, { upload: false });
    void updateEta(cached, { force: true });
  }, [profile, mapReady]);

  useEffect(() => {
    if (!profile || !mapReady || !isMonitorProfile(profile) || !locationEnabled) return;
    if (typeof window === "undefined" || !window.google) return;
    const map = mapInstanceRef.current;
    if (!map) return;

    const handleLocationTick = (event) => {
      const lat = Number(event?.detail?.lat);
      const lng = Number(event?.detail?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const coords = { lat, lng };
      updateMarker(window.google, map, coords, { upload: false });
      void updateEta(coords);

      const accuracy = Number(event?.detail?.accuracy);
      if (!Number.isFinite(accuracy)) return;

      if (!accuracyCircleRef.current) {
        accuracyCircleRef.current = new window.google.maps.Circle({
          map,
          center: coords,
          radius: accuracy,
          fillColor: "#1a73e8",
          fillOpacity: 0.15,
          strokeColor: "#1a73e8",
          strokeOpacity: 0.3,
          strokeWeight: 1,
        });
      } else {
        accuracyCircleRef.current.setCenter(coords);
        accuracyCircleRef.current.setRadius(accuracy);
      }
    };

    window.addEventListener(LOCATION_TICK_EVENT, handleLocationTick);
    return () => {
      window.removeEventListener(LOCATION_TICK_EVENT, handleLocationTick);
    };
  }, [profile, mapReady, locationEnabled]);

  useEffect(() => {
    if (!profile || !mapReady || !window.google) return;
    if (isMonitorProfile(profile)) return;

    const map = mapInstanceRef.current;
    if (!map) return;

    const routeKey = resolveRouteKey(profile);
    const routeIds = getRouteIdCandidates({
      profile,
      routeKey,
      routeStopsByKey,
    });
    if (!routeIds.length) return;

    const routeStops = routeKey ? routeStopsByKey[routeKey] : null;
    const initFirstStop = async () => {
      if (lastPositionRef.current || !routeStops?.length) return;
      const firstWithCoords = routeStops.find((stop) => stop?.coords) || routeStops[0];
      const firstCoords = await getStopCoords(firstWithCoords);
      if (!firstCoords) return;
      updateMarker(window.google, map, firstCoords, { upload: false });
      void updateEta(firstCoords, { force: true });
    };
    void initFirstStop();

    const roots = ROUTE_LIVE_COLLECTIONS;
    const unsubscribers = [];

    const applyLivePayload = (sourceKey, data) => {
      const lat = parseCoord(data?.lat);
      const lng = parseCoord(data?.lng);
      const accuracy = parseCoord(data?.accuracy);
      const excluded = Array.isArray(data?.excludedStopKeys)
        ? data.excludedStopKeys
            .map((value) =>
              value === null || value === undefined
                ? ""
                : value.toString().trim().toLowerCase()
            )
            .filter(Boolean)
        : [];

      liveExcludedBySourceRef.current[sourceKey] = excluded;
      const mergedExcluded = Array.from(
        new Set(Object.values(liveExcludedBySourceRef.current).flat())
      );
      setLiveExcludedStopKeys(mergedExcluded);

      if (lat === null || lng === null) {
        delete liveLocationBySourceRef.current[sourceKey];
        return;
      }
      if (accuracy === null || accuracy > LIVE_HIGH_ACCURACY_MAX_METERS) {
        return;
      }

      liveLocationBySourceRef.current[sourceKey] = {
        lat,
        lng,
        accuracy,
        updatedAt: Math.max(
          toMillis(data?.updatedAt),
          parseCoord(data?.updatedAtClientMs) || 0,
          parseCoord(data?.updatedAtMs) || 0
        ),
      };

      const latestLocation = Object.values(liveLocationBySourceRef.current)
        .sort((a, b) => {
          const timeDiff = (b.updatedAt || 0) - (a.updatedAt || 0);
          if (timeDiff !== 0) return timeDiff;
          const aAccuracy = Number.isFinite(a?.accuracy) ? a.accuracy : Number.POSITIVE_INFINITY;
          const bAccuracy = Number.isFinite(b?.accuracy) ? b.accuracy : Number.POSITIVE_INFINITY;
          return aAccuracy - bAccuracy;
        })[0];
      if (!latestLocation) return;
      if (latestLocation.updatedAt && Date.now() - latestLocation.updatedAt > 25000) return;

      const coords = { lat: latestLocation.lat, lng: latestLocation.lng };
      updateMarker(window.google, map, coords, {
        upload: false,
        updatedAtMs: latestLocation.updatedAt || Date.now(),
      });
      void updateEta(coords);
    };

    routeIds.forEach((routeId) => {
      roots.forEach((rootCollection) => {
        const sourceKey = `${rootCollection}:${routeId}`;
        const liveRef = doc(db, rootCollection, routeId, "live", "current");
        const unsubscribe = onSnapshot(
          liveRef,
          (snap) => {
            applyLivePayload(sourceKey, snap.exists() ? snap.data() : null);
          },
          () => null
        );
        unsubscribers.push(unsubscribe);
      });
    });

    const fetchLiveSnapshots = async () => {
      const fetches = [];
      routeIds.forEach((routeId) => {
        roots.forEach((rootCollection) => {
          const sourceKey = `${rootCollection}:${routeId}`;
          fetches.push(
            getDoc(doc(db, rootCollection, routeId, "live", "current"))
              .then((snap) => {
                applyLivePayload(sourceKey, snap.exists() ? snap.data() : null);
              })
              .catch(() => {
                // ignore polling errors; realtime listeners remain primary source
              })
          );
        });
      });
      await Promise.allSettled(fetches);
    };

    void fetchLiveSnapshots();
    const pollIntervalId = window.setInterval(
      fetchLiveSnapshots,
      MAP_MARKER_REFRESH_INTERVAL_MS
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      clearInterval(pollIntervalId);
      liveExcludedBySourceRef.current = {};
      liveLocationBySourceRef.current = {};
      setLiveExcludedStopKeys([]);
    };
  }, [profile, mapReady, routeStopsByKey]);

  useEffect(() => {
    updateRouteMarkers();
  }, [
    profile,
    institutionAddress,
    institutionCoords,
    routeStopsByKey,
    dailyStopStatuses,
    liveExcludedStopKeys,
  ]);

  useEffect(() => {
    if (!profile) return;
    if (!Object.keys(routeStopsByKey).length) return;
    if (!lastPositionRef.current) return;
    void updateEta(lastPositionRef.current, { force: true });
  }, [profile, routeStopsByKey, dailyStopStatuses]);

  useEffect(() => {
    if (!profile) return;
    const interval = setInterval(() => {
      if (!stopReadyRef.current || !schoolReadyRef.current) {
        updateRouteMarkers();
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [
    profile,
    institutionAddress,
    institutionCoords,
    routeStopsByKey,
    dailyStopStatuses,
    liveExcludedStopKeys,
  ]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (markersLoading) {
      map.setOptions({
        draggable: false,
        keyboardShortcuts: false,
        gestureHandling: "none",
      });
    } else if (mapReady) {
      map.setOptions({
        draggable: true,
        keyboardShortcuts: true,
        gestureHandling: "greedy",
      });
    }
  }, [markersLoading, mapReady]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map) return;

    const isMonitor = isMonitorProfile(profileRef.current);
    if (!isMonitor || !trailEnabled) {
      clearTrailPolyline();
      return;
    }

    if (trailPolylineRef.current) {
      trailPolylineRef.current.setMap(map);
    }
  }, [profileRouteSignature, mapReady, trailEnabled]);

  const handleCenter = () => {
    const map = mapInstanceRef.current;
    const position = lastPositionRef.current;
    if (!map) return;
    if (position) {
      map.setZoom(ZOOM_NEAR);
      map.panTo(position);
      setPulse(true);
      window.setTimeout(() => setPulse(false), 600);
      return;
    }

    if (profile && isMonitorProfile(profile) && locationEnabled) {
      // For monitor, request one precise fix on demand.
      if ("geolocation" in navigator && window.google) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const coords = {
              lat: Number(position?.coords?.latitude),
              lng: Number(position?.coords?.longitude),
            };
            if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;
            updateMarker(window.google, map, coords, { upload: false });
            map.setZoom(ZOOM_NEAR);
            map.panTo(coords);
            void updateEta(coords, { force: true });
          },
          () => null,
          GEOLOCATION_OPTIONS
        );
      }
    }
    if (userMarkerRef.current) {
      const markerPos =
        userMarkerRef.current.position ||
        (typeof userMarkerRef.current.getPosition === "function"
          ? userMarkerRef.current.getPosition()
          : null);
      if (markerPos) {
        map.setZoom(ZOOM_NEAR);
        map.panTo(markerPos);
        setPulse(true);
        window.setTimeout(() => setPulse(false), 600);
      }
    }
  };

  const handleToggleLocation = () => {
    if (typeof window === "undefined") return;
    const next = !locationEnabled;
    setLocationEnabled(next);
    window.localStorage.setItem(LOCATION_ENABLED_STORAGE_KEY, next ? "1" : "0");
    window.dispatchEvent(new CustomEvent(LOCATION_TOGGLE_EVENT));
    if (!next) {
      stopLocationWatch();
    } else if (profile && isMonitorProfile(profile)) {
      requestLocation({ force: true });
    }
  };

  const handleToggleTrail = () => {
    if (typeof window === "undefined") return;
    const next = !trailEnabled;
    setTrailEnabled(next);
    window.localStorage.setItem(TRAIL_ENABLED_STORAGE_KEY, next ? "1" : "0");

    clearTrailPolyline();
    if (!next) return;

    const map = mapInstanceRef.current;
    if (!map || !window.google) return;

    const lat = Number(lastPositionRef.current?.lat);
    const lng = Number(lastPositionRef.current?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const startPoint = { lat, lng };
    trailPathRef.current = [startPoint];
    const polyline = ensureTrailPolyline(window.google, map);
    polyline.setPath(trailPathRef.current);
  };

  const profileDisplayName = getProfileDisplayName(profile) || "Estudiante";
  const isProfileMonitor = isMonitorProfile(profile);
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
    monitorNextStop?.order !== null && monitorNextStop?.order !== undefined
      ? `#${monitorNextStop.order}`
      : "--";
  const canEnableNotifications =
    Boolean(authActions?.canEnableNotifications) &&
    typeof authActions?.enableNotifications === "function";
  const canRunLogout = typeof authActions?.logout === "function";
  const handleAuthActionsChange = useCallback((nextActions) => {
    if (!nextActions || typeof nextActions !== "object") {
      setAuthActions(EMPTY_AUTH_ACTIONS);
      return;
    }
    setAuthActions(nextActions);
  }, []);

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
        ref={mapRef}
        className={profile ? "map-surface" : "map-surface hidden"}
        aria-label="Mapa"
      />
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
              {isProfileMonitor ? (
                <>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Ruta asignada y colegio</div>
                    <div className="map-top-island-value">{monitorRouteSchoolLabel}</div>
                  </div>
                  <div className="map-top-island-card">
                    <div className="map-top-island-label">Paradero siguiente</div>
                    <div className="map-top-island-value">
                      {monitorNextStop?.title || "--"}
                    </div>
                    <div className="map-top-island-subline">{monitorNextStop?.source}</div>
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
            <div className="eta-metric">
              {etaMinutes !== null ? `${etaMinutes} min` : "--"}
            </div>
            <div className="eta-sub">
              {etaDistanceKm !== null ? `${etaDistanceKm} km` : "-- km"}
            </div>
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
