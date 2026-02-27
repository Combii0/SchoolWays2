const STORAGE_KEY = "schoolways:eta-speed-model:v1";
const DEFAULT_SPEED_MPS = 6.67; // 24 km/h
const MIN_SPEED_MPS = 1.5; // 5.4 km/h
const MAX_SPEED_MPS = 22; // 79.2 km/h
const MIN_DISTANCE_METERS = 12;
const MIN_ELAPSED_SECONDS = 4;
const MAX_ELAPSED_SECONDS = 240;
const EWMA_ALPHA = 0.24;

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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const readModel = () => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
};

const writeModel = (model) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
  } catch (error) {
    // ignore storage/quota errors
  }
};

const getTimeBucket = (timestampMs) => {
  const now = Number(timestampMs);
  const safe = Number.isFinite(now) ? now : Date.now();
  const date = new Date(safe);
  const day = date.getDay();
  const hour = date.getHours();
  const period = Math.floor(hour / 3);
  const weekend = day === 0 || day === 6 ? "we" : "wd";
  return `${weekend}:${period}`;
};

const routeGlobalKey = (routeId) => `route:${routeId}:global`;
const routeBucketKey = (routeId, bucket) => `route:${routeId}:bucket:${bucket}`;
const globalBucketKey = (bucket) => `global:bucket:${bucket}`;
const globalKey = () => "global";

const updateEntry = (entry, speedMps, timestampMs) => {
  const previous = entry && typeof entry === "object" ? entry : null;
  const previousSpeed =
    typeof previous?.speedMps === "number" && Number.isFinite(previous.speedMps)
      ? previous.speedMps
      : speedMps;
  const nextSpeed = previous
    ? previousSpeed + EWMA_ALPHA * (speedMps - previousSpeed)
    : speedMps;
  const samples = Math.min(500, Number(previous?.samples || 0) + 1);
  return {
    speedMps: clamp(nextSpeed, MIN_SPEED_MPS, MAX_SPEED_MPS),
    samples,
    updatedAtMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
  };
};

const resolveSpeedFromModel = (model, keys) => {
  for (const key of keys) {
    const entry = model[key];
    if (
      entry &&
      typeof entry?.speedMps === "number" &&
      Number.isFinite(entry.speedMps) &&
      entry.speedMps >= MIN_SPEED_MPS &&
      entry.speedMps <= MAX_SPEED_MPS
    ) {
      return entry.speedMps;
    }
  }
  return null;
};

export const recordObservedSpeed = ({
  routeId,
  from,
  to,
  startedAtMs,
  endedAtMs,
}) => {
  if (typeof window === "undefined") return;
  if (!routeId || !from || !to) return;

  const distanceMeters = distanceMetersBetween(from, to);
  if (typeof distanceMeters !== "number" || distanceMeters < MIN_DISTANCE_METERS) return;

  const elapsedMs = Number(endedAtMs) - Number(startedAtMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  const elapsedSeconds = elapsedMs / 1000;
  if (elapsedSeconds < MIN_ELAPSED_SECONDS || elapsedSeconds > MAX_ELAPSED_SECONDS) return;

  const observedSpeed = distanceMeters / elapsedSeconds;
  if (!Number.isFinite(observedSpeed)) return;
  const speedMps = clamp(observedSpeed, MIN_SPEED_MPS, MAX_SPEED_MPS);
  const nowMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now();
  const bucket = getTimeBucket(nowMs);

  const model = readModel();
  const keys = [
    routeBucketKey(routeId, bucket),
    routeGlobalKey(routeId),
    globalBucketKey(bucket),
    globalKey(),
  ];
  keys.forEach((key) => {
    model[key] = updateEntry(model[key], speedMps, nowMs);
  });
  writeModel(model);
};

export const estimateSpeedMps = ({ routeId, timestampMs }) => {
  const bucket = getTimeBucket(timestampMs);
  const model = readModel();
  const keys = routeId
    ? [
        routeBucketKey(routeId, bucket),
        routeGlobalKey(routeId),
        globalBucketKey(bucket),
        globalKey(),
      ]
    : [globalBucketKey(bucket), globalKey()];
  return resolveSpeedFromModel(model, keys) || DEFAULT_SPEED_MPS;
};

export const estimateDurationSecondsForDistance = ({
  distanceMeters,
  routeId,
  timestampMs,
}) => {
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters)) return null;
  const speedMps = estimateSpeedMps({ routeId, timestampMs });
  if (!Number.isFinite(speedMps) || speedMps <= 0) return null;
  return Math.max(1, Math.round(distanceMeters / speedMps));
};

export const estimateMetricsForPoints = ({ points, routeId, timestampMs }) => {
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
  let totalDistance = 0;
  let totalDuration = 0;
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const from = normalized[index];
    const to = normalized[index + 1];
    const segmentDistance = distanceMetersBetween(from, to);
    const safeDistance =
      typeof segmentDistance === "number" && Number.isFinite(segmentDistance)
        ? Math.max(0, segmentDistance)
        : 0;
    const durationSeconds =
      estimateDurationSecondsForDistance({
        distanceMeters: safeDistance,
        routeId,
        timestampMs,
      }) || 1;
    totalDistance += safeDistance;
    totalDuration += durationSeconds;
    legs.push({
      distanceMeters: Math.round(safeDistance),
      duration: `${durationSeconds}s`,
    });
  }

  return {
    ok: true,
    data: {
      distanceMeters: Math.round(totalDistance),
      duration: `${Math.max(1, Math.round(totalDuration))}s`,
      legs,
      optimizedIntermediateWaypointIndex: [],
      source: "predictive_local_estimate",
      estimatedSpeedMps: estimateSpeedMps({ routeId, timestampMs }),
    },
  };
};

