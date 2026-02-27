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

const SECONDS_PER_HOUR = 3600;
const ESTIMATED_SPEED_KMH = 24;

const durationFromDistance = (distanceMeters) => {
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters)) {
    return "1s";
  }
  const hours = (distanceMeters / 1000) / ESTIMATED_SPEED_KMH;
  const seconds = Math.max(1, Math.round(hours * SECONDS_PER_HOUR));
  return `${seconds}s`;
};

export async function POST(request) {
  try {
    const body = await request.json();
    const points = Array.isArray(body?.points) ? body.points : [];

    if (points.length < 2) {
      return Response.json({ error: "At least two points required" }, { status: 400 });
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
      return Response.json({ error: "Invalid coordinates" }, { status: 400 });
    }

    const legs = [];
    let distanceMetersTotal = 0;

    for (let index = 0; index < normalized.length - 1; index += 1) {
      const from = normalized[index];
      const to = normalized[index + 1];
      const segmentDistance = distanceMetersBetween(from, to);
      const safeDistance =
        typeof segmentDistance === "number" && Number.isFinite(segmentDistance)
          ? Math.max(0, segmentDistance)
          : 0;
      distanceMetersTotal += safeDistance;
      legs.push({
        distanceMeters: Math.round(safeDistance),
        duration: durationFromDistance(safeDistance),
      });
    }

    return Response.json({
      encodedPolyline: null,
      duration: durationFromDistance(distanceMetersTotal),
      distanceMeters: Math.round(distanceMetersTotal),
      legs,
      optimizedIntermediateWaypointIndex: [],
      source: "local_estimate",
    });
  } catch (error) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
}
