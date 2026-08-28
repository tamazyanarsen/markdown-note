"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Тема CodeMirror должна следовать за системной, как и остальной интерфейс. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // На сервере темы нет — берём светлую, чтобы разметка совпала при гидрации.
    () => false,
  );
}
