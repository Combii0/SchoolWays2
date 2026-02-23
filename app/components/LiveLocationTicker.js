"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";

const SEND_INTERVAL_MS = 5000;
export const LOCATION_TICK_EVENT = "schoolways:location-tick";
export const LOCATION_TOGGLE_EVENT = "schoolways:location-toggle";
export const LOCATION_ENABLED_STORAGE_KEY = "schoolways:location-enabled";
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 10000,
};

const toText = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().trim();
};

const toLowerText = (value) => toText(value).toLowerCase();

const normalizeRouteId = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const readLocationEnabled = () => {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY);
  if (raw === null) return true;
  return raw === "1";
};

const isMonitorProfile = (profile) => {
  if (!profile || typeof profile !== "object") return false;

  const role = toLowerText(profile.role);
  const accountType = toLowerText(profile.accountType);
  if (
    role === "monitor" ||
    role === "monitora" ||
    accountType === "monitor" ||
    accountType === "monitora"
  ) {
    return true;
  }

  if (
    role === "student" ||
    role === "estudiante" ||
    accountType === "student" ||
    accountType === "estudiante"
  ) {
    return false;
  }

  return Boolean(profile.route) && Boolean(profile.institutionCode || profile.institutionName);
};

export default function LiveLocationTicker() {
  const [session, setSession] = useState({ uid: "", profile: null });
  const [locationEnabled, setLocationEnabled] = useState(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let unsubscribeProfile = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      if (!user) {
        setSession({ uid: "", profile: null });
        return;
      }

      unsubscribeProfile = onSnapshot(
        doc(db, "users", user.uid),
        (snapshot) => {
          setSession({
            uid: user.uid,
            profile: snapshot.exists() ? snapshot.data() : null,
          });
        },
        () => {
          setSession({ uid: user.uid, profile: null });
        }
      );
    });

    return () => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
      }
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setLocationEnabled(readLocationEnabled());

    const handleStorage = (event) => {
      if (event?.key !== LOCATION_ENABLED_STORAGE_KEY) return;
      setLocationEnabled(readLocationEnabled());
    };
    const handleToggle = () => {
      setLocationEnabled(readLocationEnabled());
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(LOCATION_TOGGLE_EVENT, handleToggle);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(LOCATION_TOGGLE_EVENT, handleToggle);
    };
  }, []);

  useEffect(() => {
    if (!locationEnabled) return;
    if (!session.uid || !isMonitorProfile(session.profile)) return;
    if (typeof window === "undefined" || !("geolocation" in navigator)) return;

    let cancelled = false;
    const route = toText(session.profile?.route);
    const routeId = normalizeRouteId(route);
    if (!routeId) return;

    const tick = () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const sentAt = new Date().toISOString();
          const reportedAtMs = Number(position?.timestamp);
          const reportedAt = Number.isFinite(reportedAtMs)
            ? new Date(reportedAtMs).toISOString()
            : "unknown";
          const lat = Number(position?.coords?.latitude);
          const lng = Number(position?.coords?.longitude);
          const accuracy = Number(position?.coords?.accuracy);
          const accuracyText = Number.isFinite(accuracy) ? ` +/-${Math.round(accuracy)}m` : "";

          if (cancelled) {
            inFlightRef.current = false;
            return;
          }

          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            console.warn(
              `[SchoolWays GPS][global-5s] sentAt=${sentAt} reportedAt=${reportedAt} invalid-coordinates`
            );
            inFlightRef.current = false;
            return;
          }

          console.log(
            `[SchoolWays GPS][global-5s] sentAt=${sentAt} reportedAt=${reportedAt} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}${accuracyText}`
          );

          window.dispatchEvent(
            new CustomEvent(LOCATION_TICK_EVENT, {
              detail: {
                lat,
                lng,
                accuracy: Number.isFinite(accuracy) ? accuracy : null,
                sentAt,
                reportedAt,
              },
            })
          );

          try {
            const liveRef = doc(db, "routes", routeId, "live", "current");
            await setDoc(
              liveRef,
              {
                uid: session.uid,
                route,
                lat,
                lng,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );
          } catch (error) {
            console.warn(
              `[SchoolWays GPS][global-5s] sentAt=${sentAt} reportedAt=${reportedAt} firestore-write-failed`
            );
          } finally {
            inFlightRef.current = false;
          }
        },
        (error) => {
          const sentAt = new Date().toISOString();
          const code = Number(error?.code);
          const message = toText(error?.message) || "unknown";
          console.warn(
            `[SchoolWays GPS][global-5s] sentAt=${sentAt} geolocation-error code=${
              Number.isFinite(code) ? code : "unknown"
            } message=${message}`
          );
          inFlightRef.current = false;
        },
        GEOLOCATION_OPTIONS
      );
    };

    tick();
    const intervalId = window.setInterval(tick, SEND_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [locationEnabled, session.uid, session.profile]);

  return null;
}
