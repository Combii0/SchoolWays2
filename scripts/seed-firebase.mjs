import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const stripQuotes = (value = "") => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const projectId = stripQuotes(
  process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || ""
);
const clientEmail = stripQuotes(process.env.FIREBASE_ADMIN_CLIENT_EMAIL || "");
const privateKey = stripQuotes(process.env.FIREBASE_ADMIN_PRIVATE_KEY || "").replace(
  /\\n/g,
  "\n"
);

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    "Missing Firebase Admin credentials. Define FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL and FIREBASE_ADMIN_PRIVATE_KEY."
  );
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    });

const auth = getAuth(app);
const db = getFirestore(app);

const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || "12345678";
const INSTITUTION = {
  code: "L1kj2HG3fd4SA5",
  name: "Colegio En el Toke",
  address: "Ak 50 #100-88, Bogota, Colombia",
  lat: 4.6899,
  lng: -74.0618,
};

const ROUTES = [
  {
    id: "ruta-1",
    name: "Ruta 1",
    driver: "Carlos Gomez",
    monitor: "Isabel Cristina Nino",
    stops: [
      {
        id: "ruta-1-stop-01",
        title: "Calle 96 #45a 40",
        address: "Ac 100 #47a, Bogota, Colombia",
        coords: { lat: 4.6851812, lng: -74.058837 },
      },
      {
        id: "ruta-1-stop-02",
        title: "Cra. 48 #98-51",
        address: "Cra. 48 #98-51, Bogota, Colombia",
        coords: { lat: 4.6886, lng: -74.0615 },
      },
    ],
  },
];

const MONITOR_USERS = [
  {
    email: "chavita@schoolways.app",
    password: DEFAULT_PASSWORD,
    displayName: "Isabel Cristina Niño",
    profile: {
      role: "monitor",
      accountType: "monitor",
      institutionCode: INSTITUTION.code,
      institutionName: INSTITUTION.name,
      institutionAddress: INSTITUTION.address,
      institutionLat: INSTITUTION.lat,
      institutionLng: INSTITUTION.lng,
      route: "Ruta 1",
    },
  },
];

const STUDENT_CODES = [
  {
    code: "SW01-SANTIAGO",
    studentName: "Santiago Hernandez",
    institutionCode: INSTITUTION.code,
    institutionName: INSTITUTION.name,
    institutionAddress: INSTITUTION.address,
    institutionLat: INSTITUTION.lat,
    institutionLng: INSTITUTION.lng,
    route: "Ruta 1",
    stopAddress: "Ac 100 #47a, Bogota, Colombia",
  },
  {
    code: "SW01-ALEJANDRO",
    studentName: "Alejandro Hernandez",
    institutionCode: INSTITUTION.code,
    institutionName: INSTITUTION.name,
    institutionAddress: INSTITUTION.address,
    institutionLat: INSTITUTION.lat,
    institutionLng: INSTITUTION.lng,
    route: "Ruta 1",
    stopAddress: "Cra. 48 #98-51, Bogota, Colombia",
  },
];

const STUDENT_USERS = [
  {
    email: "santiagohernandez@schoolways.app",
    password: DEFAULT_PASSWORD,
    displayName: "Santiago Hernández",
    code: "SW01-SANTIAGO",
  },
  {
    email: "alejandrohernandez@schoolways.app",
    password: DEFAULT_PASSWORD,
    displayName: "Alejandro Hernández",
    code: "SW01-ALEJANDRO",
  },
];

const studentCodeByCode = Object.fromEntries(STUDENT_CODES.map((item) => [item.code, item]));
const DESIRED_ACCOUNT_EMAILS = new Set(
  [...MONITOR_USERS, ...STUDENT_USERS].map((item) => item.email)
);
const OLD_SEED_ACCOUNT_EMAILS = [
  "andrea.rios@schoolways.app",
  "luisa.vargas@schoolways.app",
  "camila.perez@schoolways.app",
  "maria@email.com",
  "laura.rueda@schoolways.app",
  "jorge.cruz@schoolways.app",
  "paula.melo@schoolways.app",
];
const OLD_STUDENT_CODES = ["SW24-SOFIA", "SW24-TOMAS", "SW24-VALE", "SW24-NICO"];
const OLD_ROUTE_IDS = ["ruta-24", "ruta-12", "ruta-03"];
const DESIRED_STUDENT_CODES = new Set(STUDENT_CODES.map((item) => item.code));
const DESIRED_ROUTE_IDS = new Set(ROUTES.map((item) => item.id));

const ensureAuthUser = async ({ email, password, displayName }) => {
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, {
      email,
      password,
      displayName,
      emailVerified: true,
    });
    return existing.uid;
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
  }

  const created = await auth.createUser({
    email,
    password,
    displayName,
    emailVerified: true,
  });
  return created.uid;
};

const routeDocument = (route) => ({
  name: route.name,
  route: route.name,
  institutionCode: INSTITUTION.code,
  institutionName: INSTITUTION.name,
  institutionAddress: INSTITUTION.address,
  institutionLat: INSTITUTION.lat,
  institutionLng: INSTITUTION.lng,
  driver: route.driver,
  monitor: route.monitor,
  stops: route.stops.map((stop) => ({
    id: stop.id,
    title: stop.title,
    address: stop.address,
    coords: stop.coords,
  })),
  schoolAddress: INSTITUTION.address,
  schoolCoords: { lat: INSTITUTION.lat, lng: INSTITUTION.lng },
  updatedAt: FieldValue.serverTimestamp(),
});

const setMirroredRouteDocs = async (route) => {
  const payload = routeDocument(route);
  const docTargets = [
    db.collection("routes").doc(route.id),
    db.collection("rutas").doc(route.id),
    db.collection("institutions").doc(INSTITUTION.code).collection("routes").doc(route.id),
    db.collection("institutions").doc(INSTITUTION.code).collection("rutas").doc(route.id),
    db.collection("colegios").doc(INSTITUTION.code).collection("routes").doc(route.id),
    db.collection("colegios").doc(INSTITUTION.code).collection("rutas").doc(route.id),
  ];

  await Promise.all(docTargets.map((ref) => ref.set(payload)));
};

const deleteMirroredRouteDocs = async (routeId) => {
  const docTargets = [
    db.collection("routes").doc(routeId),
    db.collection("rutas").doc(routeId),
    db.collection("institutions").doc(INSTITUTION.code).collection("routes").doc(routeId),
    db.collection("institutions").doc(INSTITUTION.code).collection("rutas").doc(routeId),
    db.collection("colegios").doc(INSTITUTION.code).collection("routes").doc(routeId),
    db.collection("colegios").doc(INSTITUTION.code).collection("rutas").doc(routeId),
  ];

  await Promise.all(docTargets.map((ref) => ref.delete()));
};

const deleteUnexpectedAuthUsers = async () => {
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    await Promise.all(
      result.users.map((user) => {
        if (DESIRED_ACCOUNT_EMAILS.has(user.email)) return null;
        return auth.deleteUser(user.uid);
      })
    );
    pageToken = result.pageToken;
  } while (pageToken);
};

const deleteUnexpectedDocsByEmail = async (collectionPath) => {
  const snapshot = await db.collection(collectionPath).get();
  await Promise.all(
    snapshot.docs.map((item) => {
      const email = item.data()?.email;
      if (DESIRED_ACCOUNT_EMAILS.has(email)) return null;
      return item.ref.delete();
    })
  );
};

const deleteUnexpectedDocsById = async (collectionRef, desiredIds) => {
  const snapshot = await collectionRef.get();
  await Promise.all(
    snapshot.docs.map((item) => {
      if (desiredIds.has(item.id)) return null;
      return item.ref.delete();
    })
  );
};

const cleanupRouteCollections = async () => {
  const routeCollectionRefs = [
    db.collection("routes"),
    db.collection("rutas"),
    db.collection("institutions").doc(INSTITUTION.code).collection("routes"),
    db.collection("institutions").doc(INSTITUTION.code).collection("rutas"),
    db.collection("colegios").doc(INSTITUTION.code).collection("routes"),
    db.collection("colegios").doc(INSTITUTION.code).collection("rutas"),
  ];

  await Promise.all(
    routeCollectionRefs.map((collectionRef) =>
      deleteUnexpectedDocsById(collectionRef, DESIRED_ROUTE_IDS)
    )
  );
};

const cleanupOldSeedData = async () => {
  await deleteUnexpectedAuthUsers();
  await deleteUnexpectedDocsByEmail("users");

  for (const email of OLD_SEED_ACCOUNT_EMAILS) {
    if (DESIRED_ACCOUNT_EMAILS.has(email)) continue;
    try {
      const user = await auth.getUserByEmail(email);
      await Promise.all([
        auth.deleteUser(user.uid),
        db.collection("users").doc(user.uid).delete(),
      ]);
    } catch (error) {
      if (error?.code !== "auth/user-not-found") {
        throw error;
      }
    }
  }

  await Promise.all([
    deleteUnexpectedDocsById(db.collection("studentCodes"), DESIRED_STUDENT_CODES),
    deleteUnexpectedDocsById(db.collection("studentAccounts"), DESIRED_STUDENT_CODES),
    deleteUnexpectedDocsById(
      db.collection("institutions").doc(INSTITUTION.code).collection("students"),
      DESIRED_STUDENT_CODES
    ),
    cleanupRouteCollections(),
    ...OLD_STUDENT_CODES.map((code) =>
      Promise.all([
        db.collection("studentCodes").doc(code).delete(),
        db.collection("studentAccounts").doc(code).delete(),
        db
          .collection("institutions")
          .doc(INSTITUTION.code)
          .collection("students")
          .doc(code)
          .delete(),
      ])
    ),
    ...OLD_ROUTE_IDS.map((routeId) => deleteMirroredRouteDocs(routeId)),
  ]);
};

const seedInstitution = async () => {
  const payload = {
    code: INSTITUTION.code,
    name: INSTITUTION.name,
    address: INSTITUTION.address,
    lat: INSTITUTION.lat,
    lng: INSTITUTION.lng,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await Promise.all([
    db.collection("institutions").doc(INSTITUTION.code).set(payload, { merge: true }),
    db.collection("colegios").doc(INSTITUTION.code).set(payload, { merge: true }),
  ]);
};

const seedStudentCodes = async () => {
  await Promise.all(
    STUDENT_CODES.map(async (item) => {
      const payload = {
        ...item,
        updatedAt: FieldValue.serverTimestamp(),
      };
      await Promise.all([
        db.collection("studentCodes").doc(item.code).set(payload, { merge: true }),
        db
          .collection("institutions")
          .doc(INSTITUTION.code)
          .collection("students")
          .doc(item.code)
          .set(payload, { merge: true }),
      ]);
    })
  );
};

const seedMonitorUsers = async () => {
  const created = [];
  for (const item of MONITOR_USERS) {
    const uid = await ensureAuthUser(item);
    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          uid,
          email: item.email,
          displayName: item.displayName,
          fullName: item.displayName,
          lastLogin: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          ...item.profile,
        },
        { merge: true }
      );
    created.push({ email: item.email, password: item.password, role: "monitor" });
  }
  return created;
};

const seedStudentUsers = async () => {
  const created = [];
  for (const item of STUDENT_USERS) {
    const codeData = studentCodeByCode[item.code];
    if (!codeData) {
      throw new Error(`Missing student code seed for ${item.code}`);
    }
    const uid = await ensureAuthUser(item);
    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          uid,
          email: item.email,
          displayName: item.displayName,
          fullName: item.displayName,
          role: "student",
          accountType: "student",
          studentCode: item.code,
          studentName: codeData.studentName,
          institutionCode: codeData.institutionCode,
          institutionName: codeData.institutionName,
          institutionAddress: codeData.institutionAddress,
          institutionLat: codeData.institutionLat,
          institutionLng: codeData.institutionLng,
          route: codeData.route,
          stopAddress: codeData.stopAddress,
          lastLogin: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await db
      .collection("studentAccounts")
      .doc(item.code)
      .set(
        {
          code: item.code,
          uid,
          email: item.email,
          institutionCode: codeData.institutionCode,
          studentName: codeData.studentName,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    created.push({
      email: item.email,
      password: item.password,
      role: "student",
      studentCode: item.code,
      studentName: codeData.studentName,
    });
  }
  return created;
};

const main = async () => {
  await cleanupOldSeedData();
  await seedInstitution();
  await Promise.all(ROUTES.map((route) => setMirroredRouteDocs(route)));
  await seedStudentCodes();
  const monitors = await seedMonitorUsers();
  const students = await seedStudentUsers();

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        institution: INSTITUTION,
        defaultPassword: DEFAULT_PASSWORD,
        monitors,
        students,
        studentCodes: STUDENT_CODES.map((item) => ({
          code: item.code,
          studentName: item.studentName,
          route: item.route,
          stopAddress: item.stopAddress,
        })),
        routes: ROUTES.map((route) => ({
          id: route.id,
          name: route.name,
          stops: route.stops.length,
        })),
      },
      null,
      2
    )
  );
};

await main();
