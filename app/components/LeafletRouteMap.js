"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

const DEFAULT_CENTER = [4.711, -74.0721];
const DEFAULT_ZOOM = 13;
const MAX_FIT_ZOOM = 17;
const MAP_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png";
const MAP_LABELS_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png";
const MAP_TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

const toTuple = (coords) => {
  if (!coords) return null;
  const lat = Number(coords.lat ?? coords.latitude ?? coords[0]);
  const lng = Number(coords.lng ?? coords.longitude ?? coords.lon ?? coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
};

const buildHtmlIcon = ({ html, iconSize, iconAnchor }) =>
  L.divIcon({
    html,
    className: "leaflet-bare-icon",
    iconSize,
    iconAnchor,
  });

const buildBusIcon = (isStale = false) =>
  buildHtmlIcon({
    html: `
      <div class="leaflet-bus-marker${isStale ? " is-stale" : ""}">
        <img class="leaflet-bus-marker__image" src="/icons/bus.png" alt="" />
      </div>
    `,
    iconSize: [72, 72],
    iconAnchor: [36, 36],
  });

const buildSchoolIcon = () =>
  buildHtmlIcon({
    html: `
      <div class="leaflet-school-marker">
        <span class="leaflet-school-marker__core"></span>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

const buildStopIcon = (stop, selectedStopId) => {
  const classes = [
    "leaflet-stop-pin",
    stop?.isCurrent ? "current" : "",
    stop?.isBoarded ? "boarded" : "",
    stop?.isAbsent ? "absent" : "",
    selectedStopId && selectedStopId === stop?.id ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return buildHtmlIcon({
    html: `<div class="${classes}"><span class="leaflet-stop-pin__dot"></span></div>`,
    iconSize: [30, 38],
    iconAnchor: [15, 34],
  });
};

function ViewportController({
  viewportKey,
  fallbackPoints,
  initialFocusCoords,
  initialFocusPending = false,
  initialFocusZoom = DEFAULT_ZOOM,
  focusRequest,
}) {
  const map = useMap();
  const lastViewportKeyRef = useRef("");
  const lastFocusKeyRef = useRef("");
  const initialViewportDoneRef = useRef(false);

  useEffect(() => {
    const nextKey = viewportKey || "__default__";
    if (lastViewportKeyRef.current === nextKey) return;
    lastViewportKeyRef.current = nextKey;
    initialViewportDoneRef.current = false;
    lastFocusKeyRef.current = "";
  }, [viewportKey]);

  useEffect(() => {
    if (!focusRequest?.key || lastFocusKeyRef.current === focusRequest.key) return;
    const target = toTuple(focusRequest.coords);
    if (!target) return;
    lastFocusKeyRef.current = focusRequest.key;
    map.setView(target, focusRequest.zoom || DEFAULT_ZOOM, {
      animate: true,
    });
  }, [focusRequest, map]);

  useEffect(() => {
    if (initialViewportDoneRef.current) return;

    const priorityTarget = toTuple(initialFocusCoords);
    if (priorityTarget) {
      initialViewportDoneRef.current = true;
      map.setView(priorityTarget, initialFocusZoom || DEFAULT_ZOOM, { animate: false });
      return;
    }

    if (initialFocusPending || !fallbackPoints.length) return;
    initialViewportDoneRef.current = true;

    if (fallbackPoints.length === 1) {
      map.setView(fallbackPoints[0], DEFAULT_ZOOM, { animate: false });
      return;
    }

    const bounds = L.latLngBounds(fallbackPoints);
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, {
      padding: [60, 60],
      maxZoom: MAX_FIT_ZOOM,
    });
  }, [fallbackPoints, initialFocusCoords, initialFocusPending, initialFocusZoom, map]);

  return null;
}

function MapSizeController() {
  const map = useMap();

  useEffect(() => {
    const invalidate = () => {
      map.invalidateSize({ pan: false, debounceMoveend: true });
    };

    const frameId = window.requestAnimationFrame(invalidate);
    const earlyTimerId = window.setTimeout(invalidate, 0);
    const settleTimerId = window.setTimeout(invalidate, 220);
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            invalidate();
          })
        : null;

    if (resizeObserver) {
      resizeObserver.observe(map.getContainer());
    }

    window.addEventListener("resize", invalidate);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(earlyTimerId);
      window.clearTimeout(settleTimerId);
      window.removeEventListener("resize", invalidate);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [map]);

  return null;
}

export default function LeafletRouteMap({
  busCoords = null,
  busStale = false,
  schoolCoords = null,
  stops = [],
  trailPoints = [],
  focusRequest = null,
  viewportKey = "",
  initialFocusCoords = null,
  initialFocusPending = false,
  initialFocusZoom = DEFAULT_ZOOM,
  selectedStopId = "",
}) {
  const busTuple = useMemo(() => toTuple(busCoords), [busCoords]);
  const schoolTuple = useMemo(() => toTuple(schoolCoords), [schoolCoords]);
  const stopMarkers = useMemo(
    () =>
      stops
        .map((stop) => ({
          ...stop,
          tuple: toTuple(stop?.coords),
        }))
        .filter((stop) => stop.tuple),
    [stops]
  );
  const trailTuples = useMemo(
    () => trailPoints.map((point) => toTuple(point)).filter(Boolean),
    [trailPoints]
  );
  const routeTuples = useMemo(() => stopMarkers.map((stop) => stop.tuple), [stopMarkers]);
  const fallbackPoints = useMemo(() => {
    const points = [...routeTuples];
    if (schoolTuple) {
      points.push(schoolTuple);
    }
    if (!points.length && busTuple) {
      points.push(busTuple);
    }
    return points;
  }, [busTuple, routeTuples, schoolTuple]);

  return (
    <MapContainer
      className="map-surface-leaflet"
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      zoomControl={false}
      scrollWheelZoom
      preferCanvas
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        url={MAP_TILE_URL}
        subdomains="abcd"
        attribution={MAP_TILE_ATTRIBUTION}
        className="map-tile-layer-base"
      />
      <TileLayer
        url={MAP_LABELS_TILE_URL}
        subdomains="abcd"
        attribution=""
        className="map-tile-layer-reference"
        zIndex={250}
        opacity={0.76}
      />
      <MapSizeController />
      <ViewportController
        viewportKey={viewportKey}
        fallbackPoints={fallbackPoints}
        initialFocusCoords={initialFocusCoords}
        initialFocusPending={initialFocusPending}
        initialFocusZoom={initialFocusZoom}
        focusRequest={focusRequest}
      />

      {trailTuples.length > 1 ? (
        <>
          <Polyline
            positions={trailTuples}
            pathOptions={{
              color: "#dbe9ff",
              weight: 10,
              opacity: 0.52,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          <Polyline
            positions={trailTuples}
            pathOptions={{
              color: "#4c83dd",
              weight: 5,
              opacity: 0.92,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          <Polyline
            positions={trailTuples}
            pathOptions={{
              color: "#f8fbff",
              weight: 2.5,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </>
      ) : null}

      {schoolTuple ? (
        <Marker position={schoolTuple} icon={buildSchoolIcon()}>
          <Tooltip direction="top" offset={[0, -16]}>
            <div className="leaflet-stop-tooltip">
              <strong>Colegio</strong>
            </div>
          </Tooltip>
        </Marker>
      ) : null}

      {stopMarkers.map((stop) => (
        <Marker key={stop.id} position={stop.tuple} icon={buildStopIcon(stop, selectedStopId)}>
          <Tooltip direction="top" offset={[0, -22]}>
            <div className="leaflet-stop-tooltip">
              <strong>
                #{stop.order} {stop.title}
              </strong>
              {stop.address ? <span>{stop.address}</span> : null}
              <span>{stop.statusLabel || "Pendiente"}</span>
            </div>
          </Tooltip>
        </Marker>
      ))}

      {busTuple ? (
        <Marker position={busTuple} icon={buildBusIcon(busStale)}>
          <Tooltip direction="top" offset={[0, -44]}>
            <div className="leaflet-stop-tooltip">
              <strong>{busStale ? "Ultima ubicacion del bus" : "Bus escolar"}</strong>
              {busStale ? <span>Mostrando el ultimo punto valido recibido.</span> : null}
            </div>
          </Tooltip>
        </Marker>
      ) : null}
    </MapContainer>
  );
}
