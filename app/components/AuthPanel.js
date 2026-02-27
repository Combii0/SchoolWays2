"use client";

import { useEffect, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import {
  claimSingleDeviceSession,
  isSessionOwnedByCurrentDevice,
  isSessionStale,
  keepSessionAlive,
  releaseSingleDeviceSession,
  SESSION_HEARTBEAT_MS,
} from "../lib/sessionClient";
import {
  getBrowserNotificationPermission,
  isAppleMobileBrowser,
  isStandaloneWebApp,
  setupWebPushForUser,
} from "../lib/webPushClient";

const COOKIE_KEY = "schoolways_cookie_consent";
const getCookie = (name) => {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : "";
};

const setCookie = (name, value, days = 365) => {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/`;
};

export default function AuthPanel({ onUserActionsChange = null }) {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState("login");
  const [signupStep, setSignupStep] = useState("code");
  const [studentCode, setStudentCode] = useState("");
  const [studentProfile, setStudentProfile] = useState(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupPasswordConfirm, setSignupPasswordConfirm] = useState("");
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupPasswordConfirm, setShowSignupPasswordConfirm] =
    useState(false);
  const [googlePassword, setGooglePassword] = useState("");
  const [googlePasswordConfirm, setGooglePasswordConfirm] = useState("");
  const [showGooglePassword, setShowGooglePassword] = useState(false);
  const [showGooglePasswordConfirm, setShowGooglePasswordConfirm] =
    useState(false);
  const [error, setError] = useState("");
  const [cookieConsent, setCookieConsent] = useState("");
  const [pushMessage, setPushMessage] = useState("");
  const [pushPending, setPushPending] = useState(false);
  const [pushPermission, setPushPermission] = useState("default");
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [appleInstallRequired, setAppleInstallRequired] = useState(false);
  const [appleInstallGuide, setAppleInstallGuide] = useState(false);
  const panelRef = useRef(null);
  const userDocUnsubRef = useRef(null);
  const heartbeatRef = useRef(null);
  const forcedAuthErrorRef = useRef("");
  const pushSyncRef = useRef({ uid: "", token: "" });
  const publishedActionsKeyRef = useRef("");

  const resetModal = () => {
    setView("login");
    setSignupStep("code");
    setStudentCode("");
    setStudentProfile(null);
    setLoginEmail("");
    setLoginPassword("");
    setShowLoginPassword(false);
    setEmail("");
    setSignupPassword("");
    setSignupPasswordConfirm("");
    setShowSignupPassword(false);
    setShowSignupPasswordConfirm(false);
    setGooglePassword("");
    setGooglePasswordConfirm("");
    setShowGooglePassword(false);
    setShowGooglePasswordConfirm(false);
    setError("");
    setPushMessage("");
    setAppleInstallGuide(false);
  };

  const applyPersistence = async (value) => {
    if (!value) return;
    if (value === "accepted") {
      await setPersistence(auth, browserLocalPersistence);
    } else {
      await setPersistence(auth, browserSessionPersistence);
    }
  };

  const finalizeAccount = async (firebaseUser, profile, code) => {
    if (!firebaseUser || !profile || !code) return;
    await updateProfile(firebaseUser, { displayName: profile.studentName });

    let institutionAddress = null;
    try {
      const instRef = doc(db, "institutions", profile.institutionCode);
      const instSnap = await getDoc(instRef);
      if (instSnap.exists()) {
        institutionAddress = instSnap.data().address || null;
      }
    } catch (err) {
      institutionAddress = null;
    }

    const userRef = doc(db, "users", firebaseUser.uid);
    await setDoc(
      userRef,
      {
        studentCode: code,
        studentName: profile.studentName,
        institutionCode: profile.institutionCode,
        institutionName: profile.institutionName,
        institutionAddress,
        route: profile.route,
        stopAddress: profile.stopAddress,
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    const accountRef = doc(db, "studentAccounts", code);
    await setDoc(
      accountRef,
      {
        code,
        uid: firebaseUser.uid,
        email: firebaseUser.email || null,
        institutionCode: profile.institutionCode,
        studentName: profile.studentName,
      },
      { merge: true }
    );
  };

  useEffect(() => {
    const consent = getCookie(COOKIE_KEY);
    if (consent) {
      setCookieConsent(consent);
      applyPersistence(consent);
    } else {
      applyPersistence("declined");
    }
  }, []);

  useEffect(() => {
    if (!cookieConsent) return;
    applyPersistence(cookieConsent);
  }, [cookieConsent]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        const forcedError = forcedAuthErrorRef.current;
        forcedAuthErrorRef.current = "";
        pushSyncRef.current = { uid: "", token: "" };
        setPushPermission("default");
        setPushMessage("");
        setShowPushBanner(false);
        setAppleInstallRequired(false);
        setAppleInstallGuide(false);
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
        if (userDocUnsubRef.current) {
          userDocUnsubRef.current();
          userDocUnsubRef.current = null;
        }
        setUserProfile(null);
        resetModal();
        if (forcedError) {
          setError(forcedError);
        }
        setOpen(true);
        return;
      }
      setOpen(false);
      setError("");

      const sessionClaim = await claimSingleDeviceSession(db, currentUser.uid);
      if (!sessionClaim.ok) {
        forcedAuthErrorRef.current =
          "Esta cuenta ya está abierta en otro dispositivo. Cierra esa sesión para entrar aquí.";
        await signOut(auth);
        return;
      }

      const userRef = doc(db, "users", currentUser.uid);
      const basePayload = {
        uid: currentUser.uid,
        email: currentUser.email || null,
        displayName: currentUser.displayName || null,
        photoURL: currentUser.photoURL || null,
        lastLogin: serverTimestamp(),
      };
      await setDoc(userRef, basePayload, { merge: true });

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
      }
      heartbeatRef.current = setInterval(() => {
        void keepSessionAlive(db, currentUser.uid).then((ok) => {
          if (ok) return;
          if (!heartbeatRef.current) return;
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        });
      }, SESSION_HEARTBEAT_MS);

      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
      }

      userDocUnsubRef.current = onSnapshot(userRef, async (snap) => {
        let data = snap.exists() ? snap.data() : null;
        const activeSession = data?.activeSession || null;
        const sessionOwned =
          !activeSession ||
          isSessionOwnedByCurrentDevice(activeSession) ||
          isSessionStale(activeSession);

        if (!sessionOwned) {
          forcedAuthErrorRef.current =
            "Tu sesión se abrió en otro dispositivo y se cerró aquí.";
          if (heartbeatRef.current) {
            clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
          await signOut(auth);
          return;
        }

        if (data?.studentCode && (!data.route || !data.institutionName)) {
          try {
            const codeRef = doc(db, "studentCodes", data.studentCode);
            const codeSnap = await getDoc(codeRef);
            if (codeSnap.exists()) {
              const codeData = codeSnap.data();
              data = {
                ...data,
                route: data.route || codeData.route || null,
                institutionName:
                  data.institutionName || codeData.institutionName || null,
                institutionCode:
                  data.institutionCode || codeData.institutionCode || null,
              };
              await setDoc(userRef, data, { merge: true });
            }
          } catch (err) {
            // ignore
          }
        }
        setUserProfile(data);
      });
    });
    return () => {
      unsubscribe();
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open || !user) return;
    const handleClickOutside = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, user]);

  useEffect(() => {
    let cancelled = false;

    const syncPushTokenIfPermissionGranted = async () => {
      const uid = user?.uid;
      if (!uid || !userProfile) return;
      const isAppleMobile = isAppleMobileBrowser();
      const isStandalone = isStandaloneWebApp();
      const needsAppleInstall = isAppleMobile && !isStandalone;
      setAppleInstallRequired(needsAppleInstall);
      if (needsAppleInstall) {
        setPushPermission("unsupported");
        setShowPushBanner(true);
        pushSyncRef.current = { uid: "", token: "" };
        return;
      }

      const storedToken = userProfile?.pushNotifications?.web?.token || "";
      const storedEnabled = Boolean(userProfile?.pushNotifications?.web?.enabled);
      const currentPermission = getBrowserNotificationPermission();
      setPushPermission(currentPermission);
      setShowPushBanner(currentPermission !== "granted");
      if (currentPermission !== "granted") {
        pushSyncRef.current = { uid: "", token: "" };
        return;
      }

      const result = await setupWebPushForUser({
        uid,
        requestPermission: false,
        existingToken: storedToken,
        existingEnabled: storedEnabled,
      });
      if (cancelled) return;
      if (!result?.ok) {
        if (result?.reason === "register-failed" || result?.reason === "id-token-failed") {
          setShowPushBanner(true);
        }
        return;
      }

      if (pushSyncRef.current.uid === uid && pushSyncRef.current.token === result.token) {
        return;
      }
      pushSyncRef.current = { uid, token: result.token };
    };

    void syncPushTokenIfPermissionGranted();

    return () => {
      cancelled = true;
    };
  }, [
    user?.uid,
    userProfile?.pushNotifications?.web?.token,
    userProfile?.pushNotifications?.web?.enabled,
    Boolean(userProfile),
  ]);

  const handleEnableNotifications = async () => {
    const uid = user?.uid;
    if (!uid) return;
    if (appleInstallRequired) {
      setAppleInstallGuide(true);
      setShowPushBanner(true);
      return;
    }

    setPushPending(true);
    setPushMessage("");
    try {
      const result = await setupWebPushForUser({
        uid,
        requestPermission: true,
        existingToken: userProfile?.pushNotifications?.web?.token || "",
        existingEnabled: Boolean(userProfile?.pushNotifications?.web?.enabled),
      });
      const currentPermission = getBrowserNotificationPermission();
      setPushPermission(currentPermission);

      if (result?.ok) {
        setPushMessage("Notificaciones activadas correctamente.");
        setShowPushBanner(false);
        pushSyncRef.current = { uid, token: result.token || "" };
        return;
      }

      if (result?.reason === "permission-denied") {
        setPushMessage(
          "Permiso bloqueado. Activalo en la configuracion del navegador."
        );
        return;
      }
      if (result?.reason === "unsupported") {
        setPushMessage(
          "Este navegador no soporta push web aqui. En iPhone usa Safari y agrega la app a pantalla de inicio."
        );
        return;
      }
      if (result?.reason === "missing-vapid") {
        setPushMessage("Falta configurar NEXT_PUBLIC_FIREBASE_VAPID_KEY en Vercel.");
        return;
      }
      if (
        result?.reason === "register-failed" ||
        result?.reason === "id-token-failed" ||
        result?.reason === "auth-mismatch"
      ) {
        setPushMessage(
          "No se pudo registrar el token de notificaciones en la cuenta. Intenta cerrar sesion y volver a entrar."
        );
        setShowPushBanner(true);
        return;
      }

      setPushMessage("No se pudieron activar las notificaciones en este momento.");
    } finally {
      setPushPending(false);
    }
  };

  const handleLogout = async () => {
    setPending(true);
    setError("");
    try {
      const uid = auth.currentUser?.uid;
      if (uid) {
        try {
          await releaseSingleDeviceSession(db, uid);
        } catch (err) {
          // ignore lock release errors and continue logout
        }
      }
      await signOut(auth);
      resetModal();
      setOpen(true);
    } finally {
      setPending(false);
    }
  };

  const handleAppleWebAppCreated = async () => {
    setPushPending(true);
    try {
      setAppleInstallGuide(false);
      setShowPushBanner(false);
      await handleLogout();
    } finally {
      setPushPending(false);
    }
  };

  useEffect(() => {
    if (typeof onUserActionsChange !== "function") return;
    const key = JSON.stringify({
      uid: user?.uid || "",
      pushPermission,
      pushPending,
      pushMessage,
      logoutPending: pending,
      appleInstallRequired,
      storedPushToken: userProfile?.pushNotifications?.web?.token || "",
      storedPushEnabled: Boolean(userProfile?.pushNotifications?.web?.enabled),
    });
    if (publishedActionsKeyRef.current === key) return;
    publishedActionsKeyRef.current = key;

    onUserActionsChange({
      hasUser: Boolean(user),
      canEnableNotifications: Boolean(user) && pushPermission !== "granted",
      notificationsPending: pushPending,
      notificationsMessage: pushMessage,
      logoutPending: pending,
      enableNotifications: user ? handleEnableNotifications : null,
      logout: user ? handleLogout : null,
    });
  }, [
    onUserActionsChange,
    user,
    pushPermission,
    pushPending,
    pushMessage,
    pending,
    appleInstallRequired,
    userProfile?.pushNotifications?.web?.token,
    userProfile?.pushNotifications?.web?.enabled,
    handleEnableNotifications,
    handleLogout,
  ]);

  useEffect(() => {
    return () => {
      if (typeof onUserActionsChange === "function") {
        onUserActionsChange(null);
      }
    };
  }, [onUserActionsChange]);

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    if (!loginEmail || !loginPassword) {
      setError("Completa el email y la contraseña.");
      return;
    }

    setPending(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
      setOpen(false);
      resetModal();
    } catch (err) {
      if (err?.code === "auth/wrong-password") {
        setError("Contraseña incorrecta.");
      } else if (err?.code === "auth/user-not-found") {
        setError("No existe una cuenta con ese email.");
      } else {
        setError("No se pudo iniciar sesión.");
      }
    } finally {
      setPending(false);
    }
  };

  const handleStudentCodeSubmit = async (event) => {
    event.preventDefault();
    if (!studentCode) {
      setError("Ingresa el código de estudiante.");
      return;
    }

    setPending(true);
    setError("");
    try {
      const code = studentCode.trim();
      const codeRef = doc(db, "studentCodes", code);
      const codeSnap = await getDoc(codeRef);
      if (!codeSnap.exists()) {
        setError("Código inválido.");
        return;
      }

      const accountRef = doc(db, "studentAccounts", code);
      const accountSnap = await getDoc(accountRef);
      if (accountSnap.exists()) {
        setError("Ese código ya tiene una cuenta creada.");
        return;
      }

      const profile = codeSnap.data();
      setStudentProfile(profile);
      setSignupStep("method");
    } finally {
      setPending(false);
    }
  };

  const handleEmailSignupSubmit = async (event) => {
    event.preventDefault();
    if (!email || !signupPassword || !signupPasswordConfirm) {
      setError("Completa todos los campos.");
      return;
    }
    if (signupPassword !== signupPasswordConfirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    if (!studentProfile) {
      setError("Primero valida el código de estudiante.");
      return;
    }

    setPending(true);
    setError("");
    try {
      await createUserWithEmailAndPassword(auth, email, signupPassword);
      await finalizeAccount(auth.currentUser, studentProfile, studentCode.trim());
      setOpen(false);
      resetModal();
    } catch (err) {
      if (err?.code === "auth/email-already-in-use") {
        setError("Ese correo ya está registrado.");
      } else if (err?.code === "auth/weak-password") {
        setError("La contraseña es muy débil (mínimo 6).");
      } else {
        setError("No se pudo crear la cuenta.");
      }
    } finally {
      setPending(false);
    }
  };

  const handleGoogleSignup = async () => {
    if (!studentProfile) {
      setError("Primero valida el código de estudiante.");
      return;
    }

    setPending(true);
    setError("");
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      setSignupStep("googlePassword");
    } catch (err) {
      if (
        err?.code === "auth/popup-closed-by-user" ||
        err?.code === "auth/cancelled-popup-request"
      ) {
        return;
      }
      setError("No se pudo continuar con Google.");
    } finally {
      setPending(false);
    }
  };

  const handleGooglePasswordSubmit = async (event) => {
    event.preventDefault();
    if (!googlePassword || !googlePasswordConfirm) {
      setError("Completa la contraseña.");
      return;
    }
    if (googlePassword !== googlePasswordConfirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    if (!studentProfile) {
      setError("Primero valida el código de estudiante.");
      return;
    }

    setPending(true);
    setError("");
    try {
      const currentUser = auth.currentUser;
      if (!currentUser?.email) {
        setError("Tu cuenta de Google no tiene correo asociado.");
        return;
      }
      const credential = EmailAuthProvider.credential(
        currentUser.email,
        googlePassword
      );
      await linkWithCredential(currentUser, credential);
      await finalizeAccount(currentUser, studentProfile, studentCode.trim());
      setOpen(false);
      resetModal();
    } catch (err) {
      if (err?.code === "auth/email-already-in-use") {
        setError("Ese correo ya está registrado.");
      } else {
        setError("No se pudo finalizar el registro.");
      }
    } finally {
      setPending(false);
    }
  };

  const pushUnsupported = pushPermission === "unsupported";
  const pushPermissionBlocked = pushPermission === "denied";

  return (
    <div className="auth-panel" ref={panelRef}>
      {user ? null : (
        <>
          {open ? (
            <div
              className="auth-overlay"
              role="dialog"
              aria-modal="true"
              onClick={() => {
                if (pending) return;
                setOpen(true);
              }}
            >
              <div
                className="auth-modal"
                onClick={(event) => event.stopPropagation()}
              >
                {view === "login" ? (
                  <>
                    <div className="auth-modal-title">Inicia sesión</div>
                    <form className="auth-email-form" onSubmit={handleLoginSubmit}>
                      <label className="auth-field">
                        Email
                        <input
                          type="email"
                          value={loginEmail}
                          onChange={(event) => setLoginEmail(event.target.value)}
                          autoComplete="email"
                          autoCapitalize="none"
                          spellCheck="false"
                          required
                        />
                      </label>
                      <label className="auth-field">
                        Contraseña
                        <div className="auth-password">
                          <input
                            type={showLoginPassword ? "text" : "password"}
                            value={loginPassword}
                            onChange={(event) =>
                              setLoginPassword(event.target.value)
                            }
                            autoComplete="current-password"
                            required
                          />
                          <button
                            type="button"
                            className="auth-eye"
                            onClick={() =>
                              setShowLoginPassword((value) => !value)
                            }
                            aria-label={
                              showLoginPassword
                                ? "Ocultar contraseña"
                                : "Mostrar contraseña"
                            }
                          >
                            {showLoginPassword ? (
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path
                                  d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"
                                  stroke="#1b2430"
                                  strokeWidth="2"
                                />
                                <circle
                                  cx="12"
                                  cy="12"
                                  r="3"
                                  stroke="#1b2430"
                                  strokeWidth="2"
                                />
                              </svg>
                            ) : (
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path
                                  d="M3 3l18 18"
                                  stroke="#1b2430"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                />
                                <path
                                  d="M10.5 6.6A9.8 9.8 0 0 1 12 6c5 0 9 4.2 10 6-0.33 0.6-1.04 1.7-2.1 2.8"
                                  stroke="#1b2430"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                />
                                <path
                                  d="M6.1 8.2C4.4 9.6 3.3 11.2 3 12c1 1.8 5 6 9 6 1.1 0 2.2-0.2 3.2-0.6"
                                  stroke="#1b2430"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                />
                              </svg>
                            )}
                          </button>
                        </div>
                      </label>
                      {error ? <div className="auth-error">{error}</div> : null}
                      <button
                        type="submit"
                        className="auth-primary"
                        disabled={pending}
                      >
                        Entrar
                      </button>
                    </form>
                    <button
                      type="button"
                      className="auth-link"
                      onClick={() => {
                        setView("signup");
                        setSignupStep("code");
                        setStudentCode("");
                        setStudentProfile(null);
                        setError("");
                      }}
                    >
                      ¿No tienes cuenta aún?{" "}
                      <span className="auth-link-accent">Crea una cuenta.</span>
                    </button>
                  </>
                ) : (
                  <>
                    {signupStep === "code" ? (
                      <>
                        <div className="auth-modal-title">Crea tu cuenta</div>
                        <form
                          className="auth-email-form"
                          onSubmit={handleStudentCodeSubmit}
                        >
                          <label className="auth-field">
                            Código de estudiante
                            <input
                              type="text"
                              value={studentCode}
                              onChange={(event) =>
                                setStudentCode(event.target.value)
                              }
                              required
                            />
                          </label>
                          {error ? (
                            <div className="auth-error">{error}</div>
                          ) : null}
                          <button
                            type="submit"
                            className="auth-primary"
                            disabled={pending}
                          >
                            Validar código
                          </button>
                        </form>
                        <button
                          type="button"
                          className="auth-link"
                          onClick={() => {
                            setView("login");
                            setError("");
                          }}
                        >
                          <span className="auth-link-accent">
                            Volver a iniciar sesión.
                          </span>
                        </button>
                      </>
                    ) : null}

                    {signupStep === "method" && studentProfile ? (
                      <>
                        <div className="auth-modal-title">
                          Hola {studentProfile.studentName}, bienvenido a
                          SchoolWays!
                        </div>
                        <div className="auth-subtitle">
                          {studentProfile.institutionName}
                        </div>
                        {error ? (
                          <div className="auth-error">{error}</div>
                        ) : null}
                        <button
                          type="button"
                          className="auth-google"
                          onClick={handleGoogleSignup}
                          disabled={pending}
                        >
                          Continuar con Google
                        </button>
                        <button
                          type="button"
                          className="auth-primary"
                          onClick={() => {
                            setSignupStep("email");
                            setError("");
                          }}
                          disabled={pending}
                        >
                          Crear cuenta con correo
                        </button>
                        <button
                          type="button"
                          className="auth-link"
                          onClick={() => {
                            setSignupStep("code");
                            setError("");
                          }}
                        >
                          <span className="auth-link-accent">
                            Cambiar código.
                          </span>
                        </button>
                      </>
                    ) : null}

                    {signupStep === "email" ? (
                      <>
                        <div className="auth-modal-title">Completa tu cuenta</div>
                        <form
                          className="auth-email-form"
                          onSubmit={handleEmailSignupSubmit}
                        >
                          <label className="auth-field">
                            Correo
                            <input
                              name="email"
                              type="email"
                              value={email}
                              onChange={(event) => setEmail(event.target.value)}
                              autoComplete="email"
                              required
                            />
                          </label>
                          <label className="auth-field">
                            Contraseña
                            <div className="auth-password">
                              <input
                                type={showSignupPassword ? "text" : "password"}
                                value={signupPassword}
                                onChange={(event) =>
                                  setSignupPassword(event.target.value)
                                }
                                autoComplete="new-password"
                                required
                              />
                              <button
                                type="button"
                                className="auth-eye"
                                onClick={() =>
                                  setShowSignupPassword((value) => !value)
                                }
                                aria-label={
                                  showSignupPassword
                                    ? "Ocultar contraseña"
                                    : "Mostrar contraseña"
                                }
                              >
                                {showSignupPassword ? (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="3"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M3 3l18 18"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M10.5 6.6A9.8 9.8 0 0 1 12 6c5 0 9 4.2 10 6-0.33 0.6-1.04 1.7-2.1 2.8"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M6.1 8.2C4.4 9.6 3.3 11.2 3 12c1 1.8 5 6 9 6 1.1 0 2.2-0.2 3.2-0.6"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </label>
                          <label className="auth-field">
                            Verificar contraseña
                            <div className="auth-password">
                              <input
                                type={
                                  showSignupPasswordConfirm ? "text" : "password"
                                }
                                value={signupPasswordConfirm}
                                onChange={(event) =>
                                  setSignupPasswordConfirm(event.target.value)
                                }
                                autoComplete="new-password"
                                required
                              />
                              <button
                                type="button"
                                className="auth-eye"
                                onClick={() =>
                                  setShowSignupPasswordConfirm((value) => !value)
                                }
                                aria-label={
                                  showSignupPasswordConfirm
                                    ? "Ocultar contraseña"
                                    : "Mostrar contraseña"
                                }
                              >
                                {showSignupPasswordConfirm ? (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="3"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M3 3l18 18"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M10.5 6.6A9.8 9.8 0 0 1 12 6c5 0 9 4.2 10 6-0.33 0.6-1.04 1.7-2.1 2.8"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M6.1 8.2C4.4 9.6 3.3 11.2 3 12c1 1.8 5 6 9 6 1.1 0 2.2-0.2 3.2-0.6"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </label>
                          {error ? (
                            <div className="auth-error">{error}</div>
                          ) : null}
                          <button
                            type="submit"
                            className="auth-primary"
                            disabled={pending}
                          >
                            Crear cuenta
                          </button>
                        </form>
                        <button
                          type="button"
                          className="auth-link"
                          onClick={() => {
                            setSignupStep("method");
                            setError("");
                          }}
                        >
                          <span className="auth-link-accent">
                            Volver a opciones.
                          </span>
                        </button>
                      </>
                    ) : null}

                    {signupStep === "googlePassword" ? (
                      <>
                        <div className="auth-modal-title">Crea una contraseña</div>
                        <div className="auth-subtitle">
                          La usarás para iniciar sesión con tu usuario.
                        </div>
                        <form
                          className="auth-email-form"
                          onSubmit={handleGooglePasswordSubmit}
                        >
                          <label className="auth-field">
                            Contraseña
                            <div className="auth-password">
                              <input
                                type={showGooglePassword ? "text" : "password"}
                                value={googlePassword}
                                onChange={(event) =>
                                  setGooglePassword(event.target.value)
                                }
                                autoComplete="new-password"
                                required
                              />
                              <button
                                type="button"
                                className="auth-eye"
                                onClick={() =>
                                  setShowGooglePassword((value) => !value)
                                }
                                aria-label={
                                  showGooglePassword
                                    ? "Ocultar contraseña"
                                    : "Mostrar contraseña"
                                }
                              >
                                {showGooglePassword ? (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="3"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M3 3l18 18"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M10.5 6.6A9.8 9.8 0 0 1 12 6c5 0 9 4.2 10 6-0.33 0.6-1.04 1.7-2.1 2.8"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M6.1 8.2C4.4 9.6 3.3 11.2 3 12c1 1.8 5 6 9 6 1.1 0 2.2-0.2 3.2-0.6"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </label>
                          <label className="auth-field">
                            Verificar contraseña
                            <div className="auth-password">
                              <input
                                type={
                                  showGooglePasswordConfirm ? "text" : "password"
                                }
                                value={googlePasswordConfirm}
                                onChange={(event) =>
                                  setGooglePasswordConfirm(event.target.value)
                                }
                                autoComplete="new-password"
                                required
                              />
                              <button
                                type="button"
                                className="auth-eye"
                                onClick={() =>
                                  setShowGooglePasswordConfirm((value) => !value)
                                }
                                aria-label={
                                  showGooglePasswordConfirm
                                    ? "Ocultar contraseña"
                                    : "Mostrar contraseña"
                                }
                              >
                                {showGooglePasswordConfirm ? (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="3"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <path
                                      d="M3 3l18 18"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M10.5 6.6A9.8 9.8 0 0 1 12 6c5 0 9 4.2 10 6-0.33 0.6-1.04 1.7-2.1 2.8"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                    <path
                                      d="M6.1 8.2C4.4 9.6 3.3 11.2 3 12c1 1.8 5 6 9 6 1.1 0  2.2-0.2 3.2-0.6"
                                      stroke="#1b2430"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </label>
                          {error ? (
                            <div className="auth-error">{error}</div>
                          ) : null}
                          <button
                            type="submit"
                            className="auth-primary"
                            disabled={pending}
                          >
                            Finalizar registro
                          </button>
                        </form>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}

      {!cookieConsent ? (
        <div className="cookie-banner">
          <div>
            Usamos cookies para mantener tu sesión activa y no pedirte acceso
            cada vez.
          </div>
          <div className="cookie-actions">
            <button
              type="button"
              className="cookie-button secondary"
              onClick={() => {
                setCookie(COOKIE_KEY, "declined");
                setCookieConsent("declined");
              }}
            >
              Solo esta sesión
            </button>
            <button
              type="button"
              className="cookie-button"
              onClick={() => {
                setCookie(COOKIE_KEY, "accepted");
                setCookieConsent("accepted");
              }}
            >
              Aceptar
            </button>
          </div>
        </div>
      ) : null}

      {user && showPushBanner ? (
        <div className="push-modal-overlay" role="dialog" aria-modal="true">
          <div className="push-modal" role="status" aria-live="polite">
            {appleInstallRequired ? (
              <>
                <div className="push-modal-badge">iPhone</div>
                <div className="push-modal-title">
                  {appleInstallGuide ? "Crear Web App" : "Instala SchoolWays"}
                </div>
                <div className="push-modal-text">
                  {appleInstallGuide
                    ? "Sigue estos pasos para instalar y habilitar notificaciones."
                    : "Para recibir notificaciones en iPhone debes usar la version instalada en pantalla de inicio."}
                </div>
                {appleInstallGuide ? (
                  <ol className="push-modal-steps">
                    <li>Abre el menu Compartir de Safari.</li>
                    <li>Toca Agregar a pantalla de inicio.</li>
                    <li>Confirma el nombre SchoolWays y agrega.</li>
                  </ol>
                ) : null}
                <div className="push-modal-actions">
                  {appleInstallGuide ? (
                    <button
                      type="button"
                      className="push-modal-button"
                      onClick={() => {
                        void handleAppleWebAppCreated();
                      }}
                      disabled={pushPending}
                    >
                      Ya la cree, cerrar sesion web
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="push-modal-button"
                      onClick={() => setAppleInstallGuide(true)}
                      disabled={pushPending}
                    >
                      Crear web app
                    </button>
                  )}
                  <button
                    type="button"
                    className="push-modal-button secondary"
                    onClick={() => {
                      setAppleInstallGuide(false);
                      setShowPushBanner(false);
                    }}
                    disabled={pushPending}
                  >
                    Ahora no
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="push-modal-badge">SchoolWays</div>
                <div className="push-modal-title">Activa tus notificaciones</div>
                <div className="push-modal-text">
                  {pushUnsupported
                    ? "Tu navegador no soporta push aqui. En iPhone usa Safari y agrega la app a pantalla de inicio."
                    : pushPermissionBlocked
                      ? "Tienes el permiso bloqueado. Activalo en configuracion del navegador para recibir avisos."
                      : "Recibe alertas en tiempo real cuando la ruta vaya por ti y cuando ya estes en camino al colegio."}
                </div>
                <div className="push-modal-actions">
                  {!pushUnsupported ? (
                    <button
                      type="button"
                      className="push-modal-button"
                      onClick={handleEnableNotifications}
                      disabled={pushPending}
                    >
                      {pushPending ? "Activando..." : "Permitir notificaciones"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="push-modal-button secondary"
                    onClick={() => setShowPushBanner(false)}
                    disabled={pushPending}
                  >
                    Ahora no
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
