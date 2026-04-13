"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

const DEFAULT_CENTER = [4.711, -74.0721];
const DEFAULT_ZOOM = 13;
const MAX_FIT_ZOOM = 17;

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

const buildBusIcon = () =>
  buildHtmlIcon({
    html: `
      <div class="leaflet-bus-marker">
        <span class="leaflet-bus-marker__pulse"></span>
        <span class="leaflet-bus-marker__ring"></span>
        <span class="leaflet-bus-marker__core"></span>
      </div>
    `,
    iconSize: [88, 88],
    iconAnchor: [44, 44],
  });

const buildSchoolIcon = () =>
  buildHtmlIcon({
    html: `
      <div class="leaflet-school-marker">
        <span class="leaflet-school-marker__core"></span>
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
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
    html: `<div class="${classes}"></div>`,
    iconSize: [28, 40],
    iconAnchor: [14, 36],
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
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
        className="map-tile-layer-atlas"
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
              color: "#0f766e",
              weight: 16,
              opacity: 0.16,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          <Polyline
            positions={trailTuples}
            pathOptions={{
              color: "#14b8a6",
              weight: 8,
              opacity: 0.96,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          <Polyline
            positions={trailTuples}
            pathOptions={{
              color: "#ecfeff",
              weight: 3,
              opacity: 0.92,
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
          <Tooltip direction="top" offset={[0, -16]}>
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
        <Marker position={busTuple} icon={buildBusIcon()}>
          <Tooltip direction="top" offset={[0, -44]}>
            <div className="leaflet-stop-tooltip">
              <strong>Bus escolar</strong>
            </div>
          </Tooltip>
        </Marker>
      ) : null}
    </MapContainer>
  );
}
