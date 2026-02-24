import { collection, doc, getDoc, getDocs, limit, query } from "firebase/firestore";

const SCHOOL_COLLECTIONS = ["colegios", "institutions"];
const ROUTE_COLLECTIONS = ["rutas", "routes"];
const ADDRESS_COLLECTIONS = ["direcciones", "addresses", "stops"];
const ROOT_ROUTE_COLLECTIONS = ["routes", "rutas"];

const toText = (value) => {
  if (value === null || value === undefined) return "";
  return value.toString().trim();
};

const normalizeIdentifier = (value) => {
  const text = toText(value);
  if (!text) return "";
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

const uniq = (values) => [...new Set(values.filter(Boolean))];

const normalizeMatchText = (value) => {
  const text = toText(value);
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
};

const parseCoord = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseCoordsFromValue = (value) => {
  if (!value) return null;

  const lat =
    parseCoord(value.lat) ??
    parseCoord(value.latitude) ??
    (typeof value._lat === "number" ? parseCoord(value._lat) : null);
  const lng =
    parseCoord(value.lng) ??
    parseCoord(value.lon) ??
    parseCoord(value.long) ??
    parseCoord(value.longitude) ??
    (typeof value._long === "number" ? parseCoord(value._long) : null);

  if (lat !== null && lng !== null) {
    return { lat, lng };
  }
  return null;
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

const parseOrderHint = (value) => {
  const text = toText(value);
  if (!text) return null;
  const match = text.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseStopRecord = (raw, index, fallbackTitle = "") => {
  const data =
    typeof raw === "string"
      ? { address: raw }
      : raw && typeof raw === "object"
        ? raw
        : {};

  const orderValue =
    parseCoord(data.order) ??
    parseCoord(data.orden) ??
    parseCoord(data.sequence) ??
    parseCoord(data.index) ??
    parseOrderHint(data.id) ??
    parseOrderHint(data.code) ??
    parseOrderHint(fallbackTitle) ??
    index;

  const coords =
    parseCoordsFromValue(data.coords) ??
    parseCoordsFromValue(data.location) ??
    parseCoordsFromValue(data.geo) ??
    parseCoordsFromValue(data.point) ??
    parseCoordsFromValue(data.geopoint) ??
    parseCoordsFromValue(data) ??
    null;

  const address =
    toText(data.address) ||
    toText(data.adress) ||
    toText(data.direccion) ||
    toText(data.stopAddress) ||
    toText(data.locationAddress) ||
    null;

  const title =
    toText(data.title) ||
    toText(data.name) ||
    toText(data.paradero) ||
    toText(data.label) ||
    address ||
    toText(fallbackTitle) ||
    `Paradero ${index + 1}`;

  const rawId =
    toText(data.id) ||
    toText(data.stopId) ||
    toText(data.code) ||
    toText(fallbackTitle) ||
    title ||
    address ||
    `paradero-${index + 1}`;
  const id = normalizeIdentifier(rawId) || `paradero-${index + 1}`;

  return {
    id,
    title,
    address,
    coords,
    order: Number.isFinite(orderValue) ? orderValue : index,
  };
};

const sortAndStripStops = (stops) =>
  stops
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...stop }) => stop);

const parseInlineStops = (value) => {
  if (!Array.isArray(value) || !value.length) return [];
  return sortAndStripStops(value.map((item, index) => parseStopRecord(item, index)));
};

const collectAddressCandidates = (routeData, profile) => {
  const values = [
    routeData?.startAddress,
    routeData?.startingAddress,
    routeData?.startPoint,
    routeData?.originAddress,
    routeData?.origin,
    routeData?.pickupStart,
    routeData?.inicio,
    routeData?.inicioRuta,
    routeData?.puntoInicio,
    routeData?.schoolAddress,
    routeData?.institutionAddress,
    routeData?.colegio,
    routeData?.school,
    routeData?.destinationAddress,
    routeData?.destino,
    profile?.institutionAddress,
  ];

  const normalized = values
    .map((value) => normalizeMatchText(value))
    .filter(Boolean);
  return new Set(normalized);
};

const collectCoordsCandidates = (routeData, profile) => {
  const coordsValues = [
    parseCoordsFromValue(routeData?.startCoords),
    parseCoordsFromValue(routeData?.startLocation),
    parseCoordsFromValue(routeData?.originCoords),
    parseCoordsFromValue(routeData?.originLocation),
    parseCoordsFromValue(routeData?.inicioCoords),
    parseCoordsFromValue(routeData?.puntoInicioCoords),
    parseCoordsFromValue(routeData?.schoolCoords),
    parseCoordsFromValue(routeData?.institutionCoords),
    parseCoordsFromValue(routeData?.destinationCoords),
    parseCoordsFromValue(routeData?.destinoCoords),
    parseCoordsFromValue({
      lat: profile?.institutionLat,
      lng: profile?.institutionLng,
    }),
  ].filter(Boolean);

  const unique = [];
  coordsValues.forEach((coords) => {
    if (
      unique.some(
        (candidate) =>
          candidate.lat === coords.lat && candidate.lng === coords.lng
      )
    ) {
      return;
    }
    unique.push(coords);
  });
  return unique;
};

const isOperationalStop = (stop, excludedAddressSet, excludedCoords) => {
  if (!stop) return false;

  const stopAddressKey = normalizeMatchText(stop.address);
  const stopTitleKey = normalizeMatchText(stop.title);
  if (
    (stopAddressKey && excludedAddressSet.has(stopAddressKey)) ||
    (stopTitleKey && excludedAddressSet.has(stopTitleKey))
  ) {
    return false;
  }

  if (stop.coords && excludedCoords.length) {
    const overlaps = excludedCoords.some((candidate) => {
      const distance = distanceMetersBetween(stop.coords, candidate);
      return typeof distance === "number" && distance <= 40;
    });
    if (overlaps) return false;
  }

  return true;
};

const filterOperationalStops = (stops, routeData, profile) => {
  if (!Array.isArray(stops) || !stops.length) return [];
  const excludedAddressSet = collectAddressCandidates(routeData, profile);
  const excludedCoords = collectCoordsCandidates(routeData, profile);
  const filtered = stops.filter((stop) =>
    isOperationalStop(stop, excludedAddressSet, excludedCoords)
  );

  // Avoid breaking routes that do not provide start/school metadata.
  return filtered.length ? filtered : stops;
};

export const normalizeRoute = (route) => {
  if (!route) return "";
  return route
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

export const getRouteId = (route) => {
  if (!route) return null;
  return route
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

const getInstitutionCandidates = (profile) => {
  const institutionCode = toText(profile?.institutionCode);
  const institutionName = toText(profile?.institutionName);
  return uniq([
    institutionCode,
    institutionName,
    normalizeIdentifier(institutionName),
    normalizeIdentifier(institutionCode),
  ]);
};

const getRouteCandidates = (profile) => {
  const routeText = toText(profile?.route);
  const normalizedRoute = normalizeRoute(routeText);
  const routeId = getRouteId(routeText);
  const candidates = uniq([routeText, normalizedRoute, routeId]);

  const numberMatch = routeText.match(/\d+/);
  if (numberMatch) {
    const number = numberMatch[0];
    candidates.push(number, `ruta ${number}`, `ruta-${number}`, `route-${number}`);
  }

  return uniq(candidates);
};

const buildRouteKey = (institutionId, routeName) =>
  `${institutionId}:${normalizeRoute(routeName)}`;

const extractRouteName = (routeDocId, routeData, profile) =>
  toText(routeData?.name) ||
  toText(routeData?.title) ||
  toText(routeData?.route) ||
  toText(profile?.route) ||
  toText(routeDocId) ||
  "ruta";

const readRouteStopsFromDoc = async (routeRef, routeData, profile) => {
  const inlineStops = parseInlineStops(
    routeData?.addresses ?? routeData?.direcciones ?? routeData?.stops
  );
  if (inlineStops.length) {
    return filterOperationalStops(inlineStops, routeData, profile);
  }

  for (const addressCollection of ADDRESS_COLLECTIONS) {
    try {
      const addressSnapshot = await getDocs(collection(routeRef, addressCollection));
      if (addressSnapshot.empty) continue;
      const parsed = sortAndStripStops(
        addressSnapshot.docs.map((item, index) =>
          parseStopRecord(item.data(), index, item.id)
        )
      );
      if (parsed.length) {
        return filterOperationalStops(parsed, routeData, profile);
      }
    } catch (error) {
      // try next collection name
    }
  }

  return [];
};

const readRouteDoc = async ({
  db,
  routePath,
  institutionKey,
  routeDocId,
  profile,
}) => {
  try {
    const routeRef = doc(db, ...routePath);
    const routeSnap = await getDoc(routeRef);
    if (!routeSnap.exists()) return null;

    const routeData = routeSnap.data();
    const routeName = extractRouteName(routeDocId, routeData, profile);
    const stops = await readRouteStopsFromDoc(routeRef, routeData, profile);
    if (!stops.length) return null;

    return {
      routeKey: buildRouteKey(institutionKey, routeName),
      routeId: getRouteId(routeName),
      stops,
      sourcePath: routeRef.path,
    };
  } catch (error) {
    return null;
  }
};

const pickRouteDocument = (docs, targetRoute) => {
  if (!docs.length) return null;
  if (!targetRoute) return docs[0];

  const normalizedTarget = normalizeRoute(targetRoute);
  const byName = docs.find((item) => {
    const routeData = item.data();
    const name = normalizeRoute(
      routeData?.name || routeData?.title || routeData?.route || item.id
    );
    return name === normalizedTarget;
  });
  return byName || docs[0];
};

const findInInstitutionRoutes = async (db, profile) => {
  const institutions = getInstitutionCandidates(profile);
  const routes = getRouteCandidates(profile);
  if (!institutions.length) return null;

  for (const schoolCollection of SCHOOL_COLLECTIONS) {
    for (const institutionId of institutions) {
      for (const routeCollection of ROUTE_COLLECTIONS) {
        for (const routeDocId of routes) {
          const directMatch = await readRouteDoc({
            db,
            routePath: [schoolCollection, institutionId, routeCollection, routeDocId],
            institutionKey: institutionId,
            routeDocId,
            profile,
          });
          if (directMatch) return directMatch;
        }

        try {
          const routeCollectionRef = collection(
            db,
            schoolCollection,
            institutionId,
            routeCollection
          );
          const routeSnapshot = await getDocs(query(routeCollectionRef, limit(10)));
          if (routeSnapshot.empty) continue;
          const selectedDoc = pickRouteDocument(
            routeSnapshot.docs,
            profile?.route?.toString() || ""
          );
          if (!selectedDoc) continue;

          const fallbackMatch = await readRouteDoc({
            db,
            routePath: [
              schoolCollection,
              institutionId,
              routeCollection,
              selectedDoc.id,
            ],
            institutionKey: institutionId,
            routeDocId: selectedDoc.id,
            profile,
          });
          if (fallbackMatch) return fallbackMatch;
        } catch (error) {
          // ignore and continue with next candidate
        }
      }
    }
  }

  return null;
};

const findInRootRoutes = async (db, profile) => {
  const routes = getRouteCandidates(profile);
  const institutionKey =
    toText(profile?.institutionCode) || normalizeIdentifier(profile?.institutionName) || "global";

  for (const rootCollection of ROOT_ROUTE_COLLECTIONS) {
    for (const routeDocId of routes) {
      const directMatch = await readRouteDoc({
        db,
        routePath: [rootCollection, routeDocId],
        institutionKey,
        routeDocId,
        profile,
      });
      if (directMatch) return directMatch;
    }

    try {
      const rootCollectionRef = collection(db, rootCollection);
      const rootSnapshot = await getDocs(query(rootCollectionRef, limit(10)));
      if (rootSnapshot.empty) continue;
      const selectedDoc = pickRouteDocument(
        rootSnapshot.docs,
        profile?.route?.toString() || ""
      );
      if (!selectedDoc) continue;

      const fallbackMatch = await readRouteDoc({
        db,
        routePath: [rootCollection, selectedDoc.id],
        institutionKey,
        routeDocId: selectedDoc.id,
        profile,
      });
      if (fallbackMatch) return fallbackMatch;
    } catch (error) {
      // ignore and continue
    }
  }

  return null;
};

export const loadRouteStopsForProfile = async (db, profile) => {
  if (!db || !profile) return null;

  const nestedRoute = await findInInstitutionRoutes(db, profile);
  if (nestedRoute) return nestedRoute;

  const rootRoute = await findInRootRoutes(db, profile);
  if (rootRoute) return rootRoute;

  return null;
};

export const resolveRouteKey = (profile, routeStopsByKey = {}) => {
  const keys = Object.keys(routeStopsByKey);
  if (!keys.length) return null;
  if (!profile) return keys.length === 1 ? keys[0] : null;

  const normalizedRoute = normalizeRoute(profile?.route);
  const institutionCandidates = getInstitutionCandidates(profile).map((value) =>
    value.toLowerCase()
  );

  const normalizedKeys = keys.map((key) => {
    const parts = key.split(":");
    const institution = toText(parts[0]).toLowerCase();
    const route = normalizeRoute(parts.slice(1).join(":"));
    return { key, institution, route };
  });

  if (institutionCandidates.length && normalizedRoute) {
    const exact = normalizedKeys.find(
      (item) =>
        institutionCandidates.includes(item.institution) && item.route === normalizedRoute
    );
    if (exact) return exact.key;
  }

  if (institutionCandidates.length) {
    const byInstitution = normalizedKeys.filter((item) =>
      institutionCandidates.includes(item.institution)
    );
    if (byInstitution.length === 1) return byInstitution[0].key;
  }

  if (normalizedRoute) {
    const byRoute = normalizedKeys.filter((item) => item.route === normalizedRoute);
    if (byRoute.length === 1) return byRoute[0].key;
  }

  if (keys.length === 1) return keys[0];
  return null;
};
