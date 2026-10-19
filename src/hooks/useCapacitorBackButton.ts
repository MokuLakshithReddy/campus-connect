import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/**
 * Android Hardware Back Button Navigation Handler
 * 
 * Provides native Android back button handling:
 * - When at root screens ('/', '/auth', '/change-password'), cleanly exits the application.
 * - When in nested routes or modals, navigates back in browser/router history.
 */
export function useCapacitorBackButton() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Only register listener on native platforms (Android / iOS)
    if (!Capacitor.isNativePlatform()) return;

    let listenerHandle: { remove: () => Promise<void> } | null = null;

    const registerListener = async () => {
      try {
        listenerHandle = await CapApp.addListener("backButton", ({ canGoBack }) => {
          const rootPaths = ["/", "/auth", "/change-password"];
          const isAtRoot = rootPaths.includes(location.pathname);

          if (isAtRoot) {
            CapApp.exitApp();
          } else if (canGoBack || window.history.length > 1) {
            navigate(-1);
          } else {
            CapApp.exitApp();
          }
        });
      } catch (err) {
        console.warn("Could not register Capacitor backButton listener:", err);
      }
    };

    registerListener();

    return () => {
      if (listenerHandle) {
        listenerHandle.remove().catch(() => {});
      }
    };
  }, [location.pathname, navigate]);
}
