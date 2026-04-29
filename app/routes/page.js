const routes = [
  {
    id: "R-1",
    name: "Ruta 1",
    status: "En camino",
    driver: "Carlos Gomez",
    monitor: "Isabel Cristina Niño",
    stops: ["Cra. 49 #98A-11", "Cra. 48 #98-51"],
  },
];

export default function RoutesPage() {
  return (
    <main className="page">
      <h1>Rutas escolares</h1>
      <p style={{ color: "var(--muted)" }}>
        Consulta las rutas disponibles, sus paraderos y el estado actual.
      </p>
      <div className="grid two" style={{ marginTop: 20 }}>
        {routes.map((route) => (
          <div key={route.id} className="card">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div>
                <h3 style={{ margin: 0 }}>{route.name}</h3>
                <p style={{ margin: "6px 0", color: "var(--muted)" }}>
                  Conductor: {route.driver}
                </p>
                <p style={{ margin: "6px 0", color: "var(--muted)" }}>
                  Monitora: {route.monitor}
                </p>
              </div>
              <span className="badge">{route.status}</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <strong>Paraderos</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {route.stops.map((stop) => (
                  <li key={stop} style={{ marginBottom: 4 }}>
                    {stop}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="button">Ver en mapa</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
