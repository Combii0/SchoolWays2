"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { isMonitorProfile } from "../lib/profileRoles";

const SEND_INTERVAL_MS = 3000;
const LOCATION_LOG_TAG = `global-${Math.round(SEND_INTERVAL_MS / 1000)}s`;
const ROUTE_LIVE_WRITE_COLLECTIONS = ["routes"];
export const LOCATION_TICK_EVENT = "schoolways:location-tick";
export const LOCATION_TOGGLE_EVENT = "schoolways:location-toggle";
export const LOCATION_ENABLED_STORAGE_KEY = "schoolways:location-enabled";
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 20000,
};
const GEOLOCATION_FALLBACK_OPTIONS = {
  enableHighAccuracy: false,
  maximumAge: 12000,
  timeout: 10000,
};
const HIGH_ACCURACY_MAX_METERS = 70;
const NO_FIX_RELAX_AFTER_MS = 15000;
const NO_FIX_RELAX_ACCURACY_METERS = 110;
const TARGET_ACCURACY_METERS = 38;
const BEST_EFFORT_ACCURACY_METERS = 85;
const HARD_REJECT_ACCURACY_METERS = 180;
const MAX_NOISY_JUMP_METERS = 140;
const MAX_MOVING_JUMP_METERS = 320;
const STABLE_FIX_REUSE_MS = 10000;
const MOVING_STABLE_FIX_REUSE_MS = 2500;
const RELAX_ACCURACY_AFTER_MS = 7000;
const MAX_REPORTED_FIX_AGE_MS = 10000;
const COARSE_FALLBACK_AFTER_MS = 30000;
const FIX_CLUSTER_WINDOW_MS = 9000;
const MOVING_FIX_CLUSTER_WINDOW_MS = 2500;
const MAX_RECENT_FIXES = 6;
const MIN_CLUSTER_FIXES = 2;
const MAX_CLUSTER_RADIUS_METERS = 48;
const MOVING_CLUSTER_RADIUS_METERS = 24;
const MOVING_SPEED_THRESHOLD_MPS = 2.2;
const MIN_MOVEMENT_DISTANCE_METERS = 18;
const MAX_PLAUSIBLE_SPEED_MPS = 32;
const RAW_FIX_PRIORITY_ACCURACY_METERS = 18;
const MOVING_RAW_FIX_MAX_ACCURACY_METERS = 32;
const IMMEDIATE_SEND_MIN_GAP_MS = 1200;
const IMMEDIATE_SEND_MOVE_METERS = 8;
const IMMEDIATE_SEND_MOVING_METERS = 14;
const IMMEDIATE_SEND_ACCURACY_GAIN_METERS = 8;

const toText = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().trim();
};

const normalizeRouteId = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

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

const fixSpeed = (fix) => {
  const speed = Number(fix?.speed);
  return Number.isFinite(speed) && speed >= 0 ? speed : null;
};

const fixTimestampMs = (fix) => {
  const reportedAtMs = Number(fix?.reportedAtMs);
  if (Number.isFinite(reportedAtMs) && reportedAtMs > 0) return reportedAtMs;
  const receivedAtMs = Number(fix?.receivedAtMs);
  return Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : 0;
};

const movementMetricsBetween = (from, to) => {
  const distance = distanceMetersBetween(from, to);
  const fromAt = fixTimestampMs(from);
  const toAt = fixTimestampMs(to);
  const deltaMs = Math.max(0, toAt - fromAt);
  const inferredSpeed =
    typeof distance === "number" && deltaMs >= 1000 ? distance / (deltaMs / 1000) : null;
  return {
    distance,
    deltaMs,
    inferredSpeed,
  };
};

const isBetterAccuracy = (candidate, reference, deltaMeters = 0) => {
  const candidateAccuracy = Number(candidate);
  const referenceAccuracy = Number(reference);
  if (!Number.isFinite(candidateAccuracy)) return false;
  if (!Number.isFinite(referenceAccuracy)) return true;
  return candidateAccuracy + deltaMeters < referenceAccuracy;
};

const hasRecentMotion = (samples = [], primaryFix = null, secondaryFix = null) => {
  const ordered = [primaryFix, secondaryFix, ...samples]
    .filter(Boolean)
    .sort((left, right) => fixTimestampMs(right) - fixTimestampMs(left))
    .slice(0, MAX_RECENT_FIXES);
  if (ordered.some((fix) => (fixSpeed(fix) || 0) >= MOVING_SPEED_THRESHOLD_MPS)) {
    return true;
  }
  if (ordered.length < 2) return false;

  const newest = ordered[0];
  const oldest = ordered[ordered.length - 1];
  const { distance, deltaMs, inferredSpeed } = movementMetricsBetween(oldest, newest);
  if (typeof distance !== "number" || deltaMs < 2500) return false;
  if (
    typeof inferredSpeed === "number" &&
    inferredSpeed >= MOVING_SPEED_THRESHOLD_MPS &&
    inferredSpeed <= MAX_PLAUSIBLE_SPEED_MPS
  ) {
    return true;
  }
  return distance >= MIN_MOVEMENT_DISTANCE_METERS && deltaMs <= FIX_CLUSTER_WINDOW_MS;
};

const readLocationEnabled = () => {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY);
  if (raw === null) return true;
  return raw === "1";
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
    let watchId = null;
    let queuedWrite = null;
    const startedAtMs = Date.now();
    let latestFix = null;
    let stableFix = null;
    let lastSentFix = null;
    let lastSentAtMs = 0;
    let lastAcceptedFixAtMs = 0;
    let lastWarnAtMs = 0;
    let recentFixes = [];
    const route = toText(session.profile?.route);
    const routeId = normalizeRouteId(route);
    if (!routeId) return;

    const toFix = (position) => {
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const nowMs = Date.now();
      const accuracy = Number(position?.coords?.accuracy);
      if (!Number.isFinite(accuracy)) {
        return null;
      }
      const allowedAccuracy =
        lastAcceptedFixAtMs > 0 && nowMs - lastAcceptedFixAtMs > NO_FIX_RELAX_AFTER_MS
          ? NO_FIX_RELAX_ACCURACY_METERS
          : HIGH_ACCURACY_MAX_METERS;
      if (accuracy > allowedAccuracy) {
        return null;
      }
      const reportedAtMsRaw = Number(position?.timestamp);
      const reportedAtMs = Number.isFinite(reportedAtMsRaw) ? reportedAtMsRaw : nowMs;
      if (
        latestFix &&
        Number.isFinite(reportedAtMs) &&
        nowMs - reportedAtMs > MAX_REPORTED_FIX_AGE_MS
      ) {
        return null;
      }

      const rawSpeed = Number(position?.coords?.speed);
      const speed = Number.isFinite(rawSpeed) && rawSpeed >= 0 ? rawSpeed : null;
      const rawHeading = Number(position?.coords?.heading);
      const heading = Number.isFinite(rawHeading) && rawHeading >= 0 ? rawHeading : null;

      return {
        lat,
        lng,
        accuracy,
        reportedAtMs,
        receivedAtMs: nowMs,
        speed,
        heading,
      };
    };

    const emitTickEvent = (fix) => {
      const sentAt = new Date().toISOString();
      const reportedAt = new Date(fix.reportedAtMs).toISOString();
      window.dispatchEvent(
        new CustomEvent(LOCATION_TICK_EVENT, {
          detail: {
            lat: fix.lat,
            lng: fix.lng,
            accuracy: fix.accuracy,
            speed: fix.speed,
            heading: fix.heading,
            sentAt,
            reportedAt,
          },
        })
      );
    };

    const fixAccuracy = (fix) =>
      Number.isFinite(fix?.accuracy) ? Number(fix.accuracy) : Number.POSITIVE_INFINITY;

    const fixAgeMs = (fix) =>
      Number.isFinite(fix?.receivedAtMs) ? Date.now() - Number(fix.receivedAtMs) : Number.POSITIVE_INFINITY;

    const pruneRecentFixes = (nowMs = Date.now()) => {
      recentFixes = recentFixes
        .filter((sample) => {
          return sample && nowMs - Number(sample.receivedAtMs || 0) <= FIX_CLUSTER_WINDOW_MS;
        })
        .sort((left, right) => (right.reportedAtMs || 0) - (left.reportedAtMs || 0))
        .slice(0, MAX_RECENT_FIXES);
    };

    const rememberFix = (fix) => {
      if (!fix) return;
      recentFixes = [
        fix,
        ...recentFixes.filter((sample) => {
          const sameMoment = Math.abs((sample?.reportedAtMs || 0) - fix.reportedAtMs) <= 250;
          const samePlace = distanceMetersBetween(sample, fix);
          return !sameMoment || (typeof samePlace === "number" && samePlace > 3);
        }),
      ];
      pruneRecentFixes(fix.receivedAtMs);
    };

    const buildSmoothedFix = (fallbackFix = null, preferLatest = false) => {
      pruneRecentFixes();
      const smoothingWindowMs = preferLatest ? MOVING_FIX_CLUSTER_WINDOW_MS : FIX_CLUSTER_WINDOW_MS;
      const samples = recentFixes.filter((sample) => fixAgeMs(sample) <= smoothingWindowMs);
      if (!samples.length) return fallbackFix;

      const anchors = preferLatest
        ? [fallbackFix, samples[0]].filter(Boolean)
        : [
            fallbackFix,
            ...samples
              .slice()
              .sort(
                (left, right) =>
                  fixAccuracy(left) - fixAccuracy(right) || right.reportedAtMs - left.reportedAtMs
              )
              .slice(0, 3),
          ].filter(Boolean);

      let bestCluster = null;
      anchors.forEach((anchor) => {
        const anchorAccuracy = fixAccuracy(anchor);
        const clusterRadius = Math.min(
          preferLatest ? MOVING_CLUSTER_RADIUS_METERS : MAX_CLUSTER_RADIUS_METERS,
          Math.max(preferLatest ? 10 : 18, Math.round(anchorAccuracy * (preferLatest ? 0.45 : 0.75)))
        );
        const cluster = samples.filter((sample) => {
          const distance = distanceMetersBetween(anchor, sample);
          return typeof distance !== "number" || distance <= clusterRadius;
        });
        if (!cluster.length) return;

        const averageAccuracy =
          cluster.reduce((sum, sample) => sum + fixAccuracy(sample), 0) / cluster.length;
        const totalWeight = cluster.reduce((sum, sample) => {
          const recencyWeight =
            1 + Math.max(0, smoothingWindowMs - fixAgeMs(sample)) / smoothingWindowMs;
          const accuracyWeight = 1 / Math.max(12, fixAccuracy(sample)) ** 2;
          const recencyBias = preferLatest ? recencyWeight * recencyWeight : recencyWeight;
          return sum + recencyBias * accuracyWeight;
        }, 0);
        const score = cluster.length * 1000 + totalWeight * 100000 - averageAccuracy;
        if (!bestCluster || score > bestCluster.score) {
          bestCluster = { anchor, cluster, score };
        }
      });

      if (!bestCluster) {
        return fallbackFix || samples[0];
      }
      if (
        bestCluster.cluster.length < MIN_CLUSTER_FIXES &&
        fixAccuracy(bestCluster.anchor) > TARGET_ACCURACY_METERS
      ) {
        return fallbackFix || bestCluster.anchor;
      }

      const totals = bestCluster.cluster.reduce(
        (accumulator, sample) => {
          const recencyWeight =
            1 + Math.max(0, smoothingWindowMs - fixAgeMs(sample)) / smoothingWindowMs;
          const accuracyWeight = 1 / Math.max(12, fixAccuracy(sample)) ** 2;
          const recencyBias = preferLatest ? recencyWeight * recencyWeight : recencyWeight;
          const weight = recencyBias * accuracyWeight;
          return {
            lat: accumulator.lat + sample.lat * weight,
            lng: accumulator.lng + sample.lng * weight,
            weight: accumulator.weight + weight,
          };
        },
        { lat: 0, lng: 0, weight: 0 }
      );
      if (!Number.isFinite(totals.weight) || totals.weight <= 0) {
        return fallbackFix || bestCluster.anchor;
      }

      return {
        lat: totals.lat / totals.weight,
        lng: totals.lng / totals.weight,
        accuracy: Math.max(
          8,
          Math.round(Math.min(...bestCluster.cluster.map((sample) => fixAccuracy(sample))))
        ),
        reportedAtMs: Math.max(...bestCluster.cluster.map((sample) => sample.reportedAtMs || 0)),
        receivedAtMs: Date.now(),
        speed: fixSpeed(bestCluster.cluster[0]),
        heading: bestCluster.cluster[0]?.heading ?? null,
      };
    };

    const pickRawFixForNow = (isMoving) => {
      if (!latestFix) return null;
      const latestAccuracy = fixAccuracy(latestFix);
      if (latestAccuracy <= TARGET_ACCURACY_METERS) {
        return latestFix;
      }

      const stableReuseMs = isMoving ? MOVING_STABLE_FIX_REUSE_MS : STABLE_FIX_REUSE_MS;
      if (!isMoving && stableFix && fixAgeMs(stableFix) <= stableReuseMs) {
        const stableAccuracy = fixAccuracy(stableFix);
        if (latestAccuracy >= stableAccuracy + 12) {
          return stableFix;
        }
      }

      const relaxAfterMs = isMoving ? 0 : RELAX_ACCURACY_AFTER_MS;
      if (
        latestAccuracy <= BEST_EFFORT_ACCURACY_METERS &&
        Date.now() - startedAtMs >= relaxAfterMs
      ) {
        return latestFix;
      }

      if (!isMoving && stableFix && fixAgeMs(stableFix) <= stableReuseMs) {
        return stableFix;
      }

      return isMoving ? latestFix : null;
    };

    const pickBestFixForNow = () => {
      const isMoving = hasRecentMotion(recentFixes, latestFix, stableFix);
      const latestAccuracy = fixAccuracy(latestFix);
      if (latestFix) {
        if (latestAccuracy <= RAW_FIX_PRIORITY_ACCURACY_METERS) {
          return latestFix;
        }
        if (isMoving && latestAccuracy <= MOVING_RAW_FIX_MAX_ACCURACY_METERS) {
          return latestFix;
        }
      }

      const preferred = pickRawFixForNow(isMoving);
      const smoothed = buildSmoothedFix(preferred, isMoving) || preferred;
      if (!smoothed) return latestFix;
      if (!latestFix) return smoothed;

      const smoothedAccuracy = fixAccuracy(smoothed);
      const latestIsFresh =
        Number.isFinite(latestFix.reportedAtMs) &&
        Number.isFinite(smoothed.reportedAtMs) &&
        latestFix.reportedAtMs >= smoothed.reportedAtMs;
      if (latestIsFresh && isBetterAccuracy(latestAccuracy, smoothedAccuracy, isMoving ? 10 : 4)) {
        return latestFix;
      }
      if (
        isMoving &&
        latestIsFresh &&
        latestAccuracy <= BEST_EFFORT_ACCURACY_METERS &&
        latestAccuracy <= smoothedAccuracy + 12
      ) {
        return latestFix;
      }

      return smoothed;
    };

    const captureFix = (position) => {
      const fix = toFix(position);
      if (!fix) return null;
      const incomingAccuracy = fixAccuracy(fix);

      if (latestFix) {
        const latestAccuracy = fixAccuracy(latestFix);
        const { distance: jumpMeters, inferredSpeed } = movementMetricsBetween(latestFix, fix);
        const latestIsRecent = fixAgeMs(latestFix) <= STABLE_FIX_REUSE_MS;
        const isMoving = hasRecentMotion(recentFixes, fix, latestFix);
        const plausibleMovement =
          isMoving &&
          typeof jumpMeters === "number" &&
          jumpMeters >= MIN_MOVEMENT_DISTANCE_METERS &&
          typeof inferredSpeed === "number" &&
          inferredSpeed <= MAX_PLAUSIBLE_SPEED_MPS;
        const noisyBigJump =
          incomingAccuracy > TARGET_ACCURACY_METERS &&
          typeof jumpMeters === "number" &&
          jumpMeters > (isMoving ? MAX_MOVING_JUMP_METERS : MAX_NOISY_JUMP_METERS);
        const shouldRejectNoisy =
          latestIsRecent &&
          !plausibleMovement &&
          (incomingAccuracy > HARD_REJECT_ACCURACY_METERS || noisyBigJump);
        if (shouldRejectNoisy) {
          const fallback = pickBestFixForNow() || latestFix;
          if (fallback) {
            emitTickEvent(fallback);
          }
          return fallback;
        }

        const isNewer = fix.reportedAtMs >= latestFix.reportedAtMs;
        const significantlyBetterAccuracy = incomingAccuracy + 10 < latestAccuracy;
        const comparableAccuracy = incomingAccuracy <= latestAccuracy + (isMoving ? 30 : 12);
        const plausibleNewerMovement = isNewer && plausibleMovement;
        if (significantlyBetterAccuracy || plausibleNewerMovement || (isNewer && comparableAccuracy)) {
          latestFix = fix;
        }
      } else {
        latestFix = fix;
      }

      if (
        incomingAccuracy <= TARGET_ACCURACY_METERS &&
        (!stableFix ||
          incomingAccuracy <= fixAccuracy(stableFix) + 5 ||
          fix.reportedAtMs >= stableFix.reportedAtMs)
      ) {
        stableFix = fix;
      }

      rememberFix(fix);
      const selected = pickBestFixForNow() || latestFix;
      if (selected) {
        lastAcceptedFixAtMs = Date.now();
        emitTickEvent(selected);
      }
      return selected;
    };

    const flushQueuedWrite = async () => {
      if (cancelled || inFlightRef.current) return;
      const nextWrite = queuedWrite;
      if (!nextWrite?.fix) return;
      queuedWrite = null;
      const { fix, reason = "interval" } = nextWrite;
      inFlightRef.current = true;

      const sentAtMs = Date.now();
      const sentAt = new Date(sentAtMs).toISOString();
      const reportedAt = new Date(fix.reportedAtMs).toISOString();
      const accuracyText = Number.isFinite(fix.accuracy)
        ? ` +/-${Math.round(fix.accuracy)}m`
        : "";

      console.log(
        `[SchoolWays GPS][${LOCATION_LOG_TAG}][${reason}] sentAt=${sentAt} reportedAt=${reportedAt} lat=${fix.lat.toFixed(6)} lng=${fix.lng.toFixed(6)}${accuracyText}`
      );

      try {
        const writes = ROUTE_LIVE_WRITE_COLLECTIONS.map((rootCollection) => {
          const liveRef = doc(db, rootCollection, routeId, "live", "current");
          return setDoc(
            liveRef,
            {
              uid: session.uid,
              route,
              lat: fix.lat,
              lng: fix.lng,
              accuracy: fix.accuracy,
              speed: fix.speed,
              heading: fix.heading,
              updatedAtClientMs: sentAtMs,
              updatedAtMs: fix.reportedAtMs,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        });
        const results = await Promise.allSettled(writes);
        const successfulWrites = results.filter((result) => result.status === "fulfilled").length;
        if (!successfulWrites) {
          throw new Error("no-live-write-succeeded");
        }
        lastSentAtMs = sentAtMs;
        lastSentFix = {
          ...fix,
          sentAtMs,
        };
      } catch (error) {
        console.warn(
          `[SchoolWays GPS][${LOCATION_LOG_TAG}][${reason}] sentAt=${sentAt} reportedAt=${reportedAt} firestore-write-failed`
        );
      } finally {
        inFlightRef.current = false;
        if (queuedWrite && !cancelled) {
          void flushQueuedWrite();
        }
      }
    };

    const scheduleWrite = (fix, reason = "interval") => {
      if (!fix || cancelled) return;
      queuedWrite = { fix, reason };
      if (inFlightRef.current) return;
      void flushQueuedWrite();
    };

    const shouldSendImmediately = (fix) => {
      if (!fix) return false;
      const nowMs = Date.now();
      if (!lastSentFix || lastSentAtMs === 0) return true;
      if (nowMs - lastSentAtMs < IMMEDIATE_SEND_MIN_GAP_MS) return false;
      if (nowMs - lastSentAtMs >= SEND_INTERVAL_MS - 250) return true;

      const isMoving = hasRecentMotion(recentFixes, fix, lastSentFix);
      const { distance, deltaMs } = movementMetricsBetween(lastSentFix, fix);
      const movedEnough =
        typeof distance === "number" &&
        distance >= (isMoving ? IMMEDIATE_SEND_MOVING_METERS : IMMEDIATE_SEND_MOVE_METERS);
      if (movedEnough) {
        return true;
      }

      const sentAccuracy = fixAccuracy(lastSentFix);
      const nextAccuracy = fixAccuracy(fix);
      if (isBetterAccuracy(nextAccuracy, sentAccuracy, IMMEDIATE_SEND_ACCURACY_GAIN_METERS)) {
        return true;
      }

      return (
        Number.isFinite(deltaMs) &&
        deltaMs >= SEND_INTERVAL_MS &&
        nextAccuracy <= Math.min(BEST_EFFORT_ACCURACY_METERS, sentAccuracy + 12)
      );
    };

    const requestSingleFix = (reason = "single") => {
      const handlePosition = (position) => {
        if (cancelled) return;
        const fix = captureFix(position);
        if (!fix) return;
        const preferred = pickBestFixForNow() || fix;
        if (preferred && shouldSendImmediately(preferred)) {
          scheduleWrite(preferred, reason);
        }
      };

      const logWarn = (code, message, source) => {
        const now = Date.now();
        if (now - lastWarnAtMs < 30000) return;
        lastWarnAtMs = now;
        const sentAt = new Date(now).toISOString();
        console.warn(
          `[SchoolWays GPS][${LOCATION_LOG_TAG}][${source}] sentAt=${sentAt} geolocation-error code=${
            Number.isFinite(code) ? code : "unknown"
          } message=${message || "unknown"}`
        );
      };

      const shouldAttemptCoarseFallback = () =>
        lastAcceptedFixAtMs === 0 || Date.now() - lastAcceptedFixAtMs >= COARSE_FALLBACK_AFTER_MS;

      navigator.geolocation.getCurrentPosition(
        handlePosition,
        (error) => {
          const code = Number(error?.code);
          const message = toText(error?.message) || "unknown";
          if (code === 2 || code === 3) {
            // Avoid downgrading to coarse fixes unless we have gone too long without a usable fix.
            if (shouldAttemptCoarseFallback()) {
              navigator.geolocation.getCurrentPosition(
                handlePosition,
                () => null,
                GEOLOCATION_FALLBACK_OPTIONS
              );
            }
            return;
          }
          if (code === 2) return;
          logWarn(code, message, reason);
        },
        GEOLOCATION_OPTIONS
      );
    };

    const handleWatchPosition = (position, reason = "watch") => {
      if (cancelled) return;
      const fix = captureFix(position);
      if (!fix) return;
      const preferred = pickBestFixForNow() || fix;
      if (preferred && shouldSendImmediately(preferred)) {
        scheduleWrite(preferred, lastSentAtMs === 0 ? `${reason}-first-fix` : `${reason}-live`);
      }
    };

    const handleWatchError = (error, source = "watch") => {
      const code = Number(error?.code);
      const message = toText(error?.message) || "unknown";
      if (code === 2 || code === 3) return;
      const now = Date.now();
      if (now - lastWarnAtMs < 30000) return;
      lastWarnAtMs = now;
      const sentAt = new Date(now).toISOString();
      console.warn(
        `[SchoolWays GPS][${LOCATION_LOG_TAG}][${source}] sentAt=${sentAt} geolocation-error code=${
          Number.isFinite(code) ? code : "unknown"
        } message=${message}`
      );
    };

    const recoverFreshFix = (reason = "recovery") => {
      if (cancelled) return;
      const preferred = pickBestFixForNow();
      if (preferred && shouldSendImmediately(preferred)) {
        scheduleWrite(preferred, `${reason}-cached`);
      }
      requestSingleFix(reason);
    };

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        handleWatchPosition(position, "watch");
      },
      (error) => {
        handleWatchError(error, "watch");
        recoverFreshFix("watch-recovery");
      },
      GEOLOCATION_OPTIONS
    );

    const tick = () => {
      const preferred = pickBestFixForNow();
      if (preferred) {
        const shouldWrite =
          lastSentAtMs === 0 || Date.now() - lastSentAtMs >= SEND_INTERVAL_MS - 250;
        if (shouldWrite) {
          scheduleWrite(preferred, "interval");
        }
      }
      requestSingleFix(preferred ? "interval-refresh" : "interval-fallback");
    };

    requestSingleFix("startup");
    const intervalId = window.setInterval(tick, SEND_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (!document.hidden) {
        recoverFreshFix("foreground");
      }
    };
    const handleOnline = () => {
      recoverFreshFix("online");
    };
    const handleFocus = () => {
      recoverFreshFix("focus");
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      queuedWrite = null;
      inFlightRef.current = false;
      window.clearInterval(intervalId);
      if (watchId !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchId);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
    };
  }, [locationEnabled, session.uid, session.profile]);

  return null;
}
