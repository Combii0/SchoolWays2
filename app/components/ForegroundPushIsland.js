"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";

const HIDE_DELAY_MS = 5000;
const EXIT_ANIMATION_MS = 240;

export default function ForegroundPushIsland() {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const hideTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const lastNotificationIdRef = useRef("");

  const showToast = (payload = {}) => {
    const nextTitle =
      payload?.title && payload.title.toString().trim()
        ? payload.title.toString().trim()
        : "SchoolWays";
    const nextBody =
      payload?.body && payload.body.toString().trim()
        ? payload.body.toString().trim()
        : "Tienes una notificacion nueva.";

    setTitle(nextTitle);
    setBody(nextBody);
    setClosing(false);
    setVisible(true);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([220, 120, 220]);
    }
  };

  useEffect(() => {
    const clearTimers = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };

    const queueHide = () => {
      clearTimers();
      hideTimerRef.current = setTimeout(() => {
        setClosing(true);
        closeTimerRef.current = setTimeout(() => {
          setVisible(false);
          setClosing(false);
          closeTimerRef.current = null;
        }, EXIT_ANIMATION_MS);
      }, HIDE_DELAY_MS);
    };

    const handleForegroundPushEvent = (event) => {
      showToast({
        title: event?.detail?.title,
        body: event?.detail?.body,
      });
      queueHide();
    };

    window.addEventListener("schoolways:push-foreground", handleForegroundPushEvent);

    return () => {
      clearTimers();
      window.removeEventListener(
        "schoolways:push-foreground",
        handleForegroundPushEvent
      );
    };
  }, []);

  useEffect(() => {
    let unsubscribeNotifications = null;
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      if (unsubscribeNotifications) {
        unsubscribeNotifications();
        unsubscribeNotifications = null;
      }
      lastNotificationIdRef.current = "";
      if (!currentUser) return;

      let initialized = false;
      unsubscribeNotifications = onSnapshot(
        doc(db, "users", currentUser.uid),
        (snapshot) => {
          if (!snapshot.exists()) {
            initialized = true;
            return;
          }

          const latest = snapshot.data()?.lastRouteNotification || null;
          const latestId =
            latest?.id && latest.id.toString().trim()
              ? latest.id.toString().trim()
              : "";
          if (!latestId) {
            initialized = true;
            return;
          }

          if (!initialized) {
            initialized = true;
            lastNotificationIdRef.current = latestId;
            return;
          }
          if (lastNotificationIdRef.current === latestId) return;

          lastNotificationIdRef.current = latestId;
          showToast({
            title: latest?.title,
            body: latest?.body,
          });
          if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
          }
          if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
          }
          hideTimerRef.current = setTimeout(() => {
            setClosing(true);
            closeTimerRef.current = setTimeout(() => {
              setVisible(false);
              setClosing(false);
              closeTimerRef.current = null;
            }, EXIT_ANIMATION_MS);
          }, HIDE_DELAY_MS);
        },
        () => null
      );
    });

    return () => {
      if (unsubscribeNotifications) {
        unsubscribeNotifications();
      }
      unsubscribeAuth();
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={closing ? "push-island closing" : "push-island"}
      role="status"
      aria-live="polite"
    >
      <div className="push-island-icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 3 2 21h20L12 3Z"
            fill="#f59e0b"
            stroke="#92400e"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M12 9v6"
            stroke="#1f2937"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <circle cx="12" cy="18" r="1.2" fill="#1f2937" />
        </svg>
      </div>
      <div className="push-island-copy">
        <div className="push-island-title">{title}</div>
        <div className="push-island-body">{body}</div>
      </div>
      <button
        type="button"
        className="push-island-close"
        onClick={() => {
          setClosing(true);
          if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
          }
          if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
          }
          closeTimerRef.current = setTimeout(() => {
            setVisible(false);
            setClosing(false);
            closeTimerRef.current = null;
          }, EXIT_ANIMATION_MS);
        }}
        aria-label="Cerrar notificacion"
      >
        ×
      </button>
    </div>
  );
}
