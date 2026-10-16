// Tauri has no Node server, so the app runs as an SPA (adapter-static fallback).
import "../app.css";
import "$lib/startup"; // starts opening the last vault right away
export const ssr = false;
