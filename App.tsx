// ============================================================
// NEXUS FLOW — Fase 1: App di Tracking Giornata
// ============================================================

import { registerRootComponent } from 'expo';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  StatusBar,
  SafeAreaView,
  AppState,
  AppStateStatus,
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Accelerometer } from 'expo-sensors';

// ============================================================
// COSTANTI CONFIGURABILI — modifica qui per calibrare
// ============================================================
const STOP_SPEED_KMH        = 3;      // km/h sotto cui il veicolo è fermo
const STOP_CONFIRM_SEC      = 60;     // secondi per confermare una sosta reale
const STOP_IGNORE_SEC       = 30;     // soste più brevi vengono ignorate (semafori)
const MIN_DIST_METERS       = 100;    // distanza minima per registrare un tragitto
const TRAVEL_SPEED_KMH      = 15;     // km/h sopra cui si attiva modalità VIAGGIO
const REST_INACTIVITY_MIN   = 5;      // minuti fermi per passare in modalità RIPOSO

const GPS_INTERVAL_CITY_MS  = 15_000; // intervallo GPS in modalità CITTÀ (ms)
const GPS_INTERVAL_TRAVEL_MS = 5_000; // intervallo GPS in modalità VIAGGIO (ms)
const GPS_DISTANCE_CITY_M   = 10;     // distanza minima aggiornamento CITTÀ (m)
const GPS_DISTANCE_TRAVEL_M = 5;      // distanza minima aggiornamento VIAGGIO (m)
const GPS_ACCURACY_LIMIT_M  = 50;     // ignora letture meno accurate di questo valore

const ACC_HZ_REST           = 1;      // frequenza accelerometro in RIPOSO (Hz)
const ACC_HZ_CITY           = 5;      // frequenza accelerometro in CITTÀ (Hz)
const ACC_HZ_TRAVEL         = 50;     // frequenza accelerometro in VIAGGIO (Hz)
const ACC_VARIANCE_THRESHOLD = 0.008; // soglia varianza per rilevare movimento in RIPOSO
const ACC_VARIANCE_WINDOW   = 20;     // campioni per il calcolo della varianza

const UI_POLL_MS            = 2_000;  // intervallo polling AsyncStorage → UI (ms)

// ============================================================
// CHIAVI STORAGE & NOME TASK
// ============================================================
const KEY_STATE   = '@nf_state_v1';
const KEY_DAY     = '@nf_day_v1';
const TASK_BG_LOC = 'nf-background-location';

// ============================================================
// TIPI
// ============================================================
type VehicleState = 'stopped' | 'slow' | 'moving';
type AppMode      = 'rest' | 'city' | 'travel';

interface StopRecord {
  id: string;
  startTs: number;
  endTs: number;
  lat: number;
  lng: number;
  address: string;
  postalCode: string;
  durationSec: number;
}

interface TripRecord {
  id: string;
  startTs: number;
  endTs: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceMeters: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
}

interface TrackingState {
  isTracking: boolean;
  mode: AppMode;
  vehicleState: VehicleState;
  slowSinceTs: number | null;
  slowLat: number | null;
  slowLng: number | null;
  tripId: string | null;
  tripStartTs: number | null;
  tripStartLat: number | null;
  tripStartLng: number | null;
  tripLastLat: number | null;
  tripLastLng: number | null;
  tripDistanceM: number;
  tripMaxSpeedKmh: number;
  tripSpeedSum: number;
  tripSpeedCount: number;
  lastLat: number | null;
  lastLng: number | null;
  lastSpeedKmh: number;
}

interface DayData {
  date: string;
  stops: StopRecord[];
  trips: TripRecord[];
}

// ============================================================
// UTILITY
// ============================================================
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Distanza in metri tra due coordinate GPS (formula di Haversine) */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Varianza di un array di numeri */
function calcVariance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ============================================================
// STORAGE HELPERS
// ============================================================
function defaultState(): TrackingState {
  return {
    isTracking: false,
    mode: 'city',
    vehicleState: 'stopped',
    slowSinceTs: null,
    slowLat: null,
    slowLng: null,
    tripId: null,
    tripStartTs: null,
    tripStartLat: null,
    tripStartLng: null,
    tripLastLat: null,
    tripLastLng: null,
    tripDistanceM: 0,
    tripMaxSpeedKmh: 0,
    tripSpeedSum: 0,
    tripSpeedCount: 0,
    lastLat: null,
    lastLng: null,
    lastSpeedKmh: 0,
  };
}

function defaultDay(): DayData {
  return { date: todayISO(), stops: [], trips: [] };
}

async function loadState(): Promise<TrackingState> {
  try {
    const raw = await AsyncStorage.getItem(KEY_STATE);
    return raw ? (JSON.parse(raw) as TrackingState) : defaultState();
  } catch {
    return defaultState();
  }
}

async function saveState(s: TrackingState): Promise<void> {
  await AsyncStorage.setItem(KEY_STATE, JSON.stringify(s));
}

async function loadDay(): Promise<DayData> {
  try {
    const raw = await AsyncStorage.getItem(KEY_DAY);
    if (!raw) return defaultDay();
    const d = JSON.parse(raw) as DayData;
    return d.date === todayISO() ? d : defaultDay();
  } catch {
    return defaultDay();
  }
}

async function saveDay(d: DayData): Promise<void> {
  await AsyncStorage.setItem(KEY_DAY, JSON.stringify(d));
}

// ============================================================
// REVERSE GEOCODING
// ============================================================
async function reverseGeocode(lat: number, lng: number): Promise<{ address: string; postalCode: string }> {
  try {
    const res = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    if (res.length > 0) {
      const r = res[0];
      const parts = [r.street, r.streetNumber, r.city].filter(Boolean);
      return {
        address: parts.join(', ') || r.city || 'Posizione sconosciuta',
        postalCode: r.postalCode ?? '',
      };
    }
  } catch {
    /* ignora errori di geocoding */
  }
  return { address: 'Posizione sconosciuta', postalCode: '' };
}

// ============================================================
// ELABORAZIONE POSIZIONE — usata sia dal task BG che dal foreground
// ============================================================
async function processLocation(loc: Location.LocationObject): Promise<void> {
  const state = await loadState();
  if (!state.isTracking) return;

  const day = await loadDay();
  const { latitude: lat, longitude: lng, speed, accuracy } = loc.coords;
  const ts = loc.timestamp;
  const speedKmh = Math.max(0, (speed ?? 0) * 3.6);

  // Scarta letture troppo imprecise
  if ((accuracy ?? 999) > GPS_ACCURACY_LIMIT_M) {
    return;
  }

  // Aggiorna ultima posizione nota
  state.lastLat = lat;
  state.lastLng = lng;
  state.lastSpeedKmh = speedKmh;

  // Aggiorna modalità in base alla velocità
  if (speedKmh >= TRAVEL_SPEED_KMH) state.mode = 'travel';
  else if (speedKmh >= STOP_SPEED_KMH) state.mode = 'city';

  // ── STATE MACHINE VEICOLO ───────────────────────────────
  if (speedKmh < STOP_SPEED_KMH) {
    // Veicolo lento / fermo
    if (state.vehicleState === 'moving') {
      state.vehicleState = 'slow';
      state.slowSinceTs = ts;
      state.slowLat = lat;
      state.slowLng = lng;
    } else if (state.vehicleState === 'slow') {
      const slowSec = (ts - (state.slowSinceTs ?? ts)) / 1000;

      if (slowSec >= STOP_CONFIRM_SEC) {
        state.vehicleState = 'stopped';

        // Chiudi il tragitto corrente se abbastanza lungo
        if (state.tripId && state.tripDistanceM >= MIN_DIST_METERS) {
          const avg = state.tripSpeedCount > 0
            ? state.tripSpeedSum / state.tripSpeedCount
            : 0;
          day.trips.push({
            id: state.tripId,
            startTs: state.tripStartTs!,
            endTs: ts,
            startLat: state.tripStartLat!,
            startLng: state.tripStartLng!,
            endLat: lat,
            endLng: lng,
            distanceMeters: state.tripDistanceM,
            avgSpeedKmh: Math.round(avg),
            maxSpeedKmh: Math.round(state.tripMaxSpeedKmh),
          });
        }
        // Reset tragitto
        state.tripId = null;
        state.tripStartTs = null;
        state.tripStartLat = null;
        state.tripStartLng = null;
        state.tripLastLat = null;
        state.tripLastLng = null;
        state.tripDistanceM = 0;
        state.tripMaxSpeedKmh = 0;
        state.tripSpeedSum = 0;
        state.tripSpeedCount = 0;

        // Registra la sosta
        const stopLat = state.slowLat ?? lat;
        const stopLng = state.slowLng ?? lng;
        const stopStart = state.slowSinceTs ?? ts;
        const alreadySaved = day.stops.some(s => s.startTs === stopStart);
        if (!alreadySaved) {
          const { address, postalCode } = await reverseGeocode(stopLat, stopLng);
          day.stops.push({
            id: uid(),
            startTs: stopStart,
            endTs: ts,
            lat: stopLat,
            lng: stopLng,
            address,
            postalCode,
            durationSec: Math.round((ts - stopStart) / 1000),
          });
        }

        // Passa a RIPOSO dopo REST_INACTIVITY_MIN
        if ((ts - (state.slowSinceTs ?? ts)) / 60000 >= REST_INACTIVITY_MIN) {
          state.mode = 'rest';
        }
      }
    }
    // vehicleState === 'stopped' → nessuna azione
  } else {
    // Veicolo in movimento
    if (state.vehicleState === 'slow') {
      const slowSec = (ts - (state.slowSinceTs ?? ts)) / 1000;
      if (slowSec < STOP_IGNORE_SEC) {
        // Era solo un semaforo, ignora
        state.vehicleState = 'moving';
        state.slowSinceTs = null;
        state.slowLat = null;
        state.slowLng = null;
      } else {
        // Era una sosta reale, salva e riparti
        const stopLat = state.slowLat ?? lat;
        const stopLng = state.slowLng ?? lng;
        const stopStart = state.slowSinceTs ?? ts;
        const alreadySaved = day.stops.some(s => s.startTs === stopStart);
        if (!alreadySaved) {
          const { address, postalCode } = await reverseGeocode(stopLat, stopLng);
          day.stops.push({
            id: uid(),
            startTs: stopStart,
            endTs: ts,
            lat: stopLat,
            lng: stopLng,
            address,
            postalCode,
            durationSec: Math.round((ts - stopStart) / 1000),
          });
        }
        state.vehicleState = 'moving';
        state.slowSinceTs = null;
        state.slowLat = null;
        state.slowLng = null;
      }
    } else if (state.vehicleState === 'stopped') {
      state.vehicleState = 'moving';
      state.mode = 'city';
      state.slowSinceTs = null;
    }

    // Aggiorna tragitto corrente
    if (state.vehicleState === 'moving') {
      if (!state.tripId) {
        state.tripId = uid();
        state.tripStartTs = ts;
        state.tripStartLat = lat;
        state.tripStartLng = lng;
        state.tripLastLat = lat;
        state.tripLastLng = lng;
        state.tripDistanceM = 0;
        state.tripMaxSpeedKmh = speedKmh;
        state.tripSpeedSum = speedKmh;
        state.tripSpeedCount = 1;
      } else {
        if (state.tripLastLat !== null && state.tripLastLng !== null) {
          const seg = haversineM(state.tripLastLat, state.tripLastLng, lat, lng);
          // Sanity check: max ~280m in 5 secondi a 200 km/h
          if (seg < 300) state.tripDistanceM += seg;
        }
        state.tripLastLat = lat;
        state.tripLastLng = lng;
        if (speedKmh > state.tripMaxSpeedKmh) state.tripMaxSpeedKmh = speedKmh;
        state.tripSpeedSum += speedKmh;
        state.tripSpeedCount++;
      }
    }
  }

  await saveState(state);
  await saveDay(day);
}

// ============================================================
// TASK BACKGROUND — deve essere definito a livello di modulo
// ============================================================
TaskManager.defineTask(TASK_BG_LOC, async ({ data, error }) => {
  if (error) {
    console.error('[NF BG]', error.message);
    return;
  }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    for (const loc of locations) {
      await processLocation(loc);
    }
  }
});

// ============================================================
// OPZIONI GPS PER MODALITÀ
// ============================================================
function gpsOptions(mode: AppMode): Location.LocationTaskOptions {
  const isTravel = mode === 'travel';
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: isTravel ? GPS_INTERVAL_TRAVEL_MS : GPS_INTERVAL_CITY_MS,
    distanceInterval: isTravel ? GPS_DISTANCE_TRAVEL_M : GPS_DISTANCE_CITY_M,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    deferredUpdatesInterval: 0,
    deferredUpdatesDistance: 0,
    foregroundService: {
      notificationTitle: 'Nexus Flow',
      notificationBody: isTravel ? '🚛 Tracciamento viaggio attivo' : '🏙 Tracciamento città attivo',
      notificationColor: '#00FF88',
    },
  };
}

// ============================================================
// APP COMPONENT
// ============================================================
export default function App() {
  // ── UI state ─────────────────────────────────────────────
  const [isTracking, setIsTracking]       = useState(false);
  const [mode, setMode]                   = useState<AppMode>('city');
  const [vehicleState, setVehicleState]   = useState<VehicleState>('stopped');
  const [speedKmh, setSpeedKmh]           = useState(0);
  const [tripDistM, setTripDistM]         = useState(0);
  const [tripMaxSpd, setTripMaxSpd]       = useState(0);
  const [dayStops, setDayStops]           = useState<StopRecord[]>([]);
  const [dayTrips, setDayTrips]           = useState<TripRecord[]>([]);
  const [lastSync, setLastSync]           = useState<number | null>(null);
  const [currentCity, setCurrentCity]     = useState<string>('—');

  // ── refs ─────────────────────────────────────────────────
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const accRef    = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);
  const accBuf    = useRef<number[]>([]);
  const modeRef   = useRef<AppMode>('city'); // ref per accesso in closure accelerometro

  // ── permissions ──────────────────────────────────────────
  async function requestPermissions(): Promise<boolean> {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') {
      Alert.alert(
        'GPS non disponibile',
        'Concedi l\'accesso alla posizione per usare Nexus Flow.',
      );
      return false;
    }
    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    if (bg !== 'granted') {
      Alert.alert(
        'Background GPS',
        'Per il tracciamento continuo con schermo spento, vai in Impostazioni → Privacy → Posizione → Nexus Flow → "Sempre".',
        [{ text: 'OK' }],
      );
      // Continuiamo comunque, funzionerà in foreground
    }
    return true;
  }

  // ── avvio GPS task ────────────────────────────────────────
  async function startGps(m: AppMode): Promise<void> {
    const running = await Location.hasStartedLocationUpdatesAsync(TASK_BG_LOC).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(TASK_BG_LOC).catch(() => {});
    await Location.startLocationUpdatesAsync(TASK_BG_LOC, gpsOptions(m));
  }

  async function stopGps(): Promise<void> {
    const running = await Location.hasStartedLocationUpdatesAsync(TASK_BG_LOC).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(TASK_BG_LOC).catch(() => {});
  }

  // ── accelerometro ─────────────────────────────────────────
  function startAcc(m: AppMode): void {
    accRef.current?.remove();
    accBuf.current = [];
    Accelerometer.setUpdateInterval(Math.round(1000 / (m === 'travel' ? ACC_HZ_TRAVEL : m === 'city' ? ACC_HZ_CITY : ACC_HZ_REST)));
    accRef.current = Accelerometer.addListener(({ x, y, z }) => {
      const mag = Math.sqrt(x * x + y * y + z * z);
      accBuf.current.push(mag);
      if (accBuf.current.length > ACC_VARIANCE_WINDOW) accBuf.current.shift();

      // In RIPOSO: se rileva movimento, sveglia GPS
      if (modeRef.current === 'rest' && accBuf.current.length >= ACC_VARIANCE_WINDOW) {
        const v = calcVariance(accBuf.current);
        if (v > ACC_VARIANCE_THRESHOLD) {
          console.log('[ACC] Movimento rilevato in RIPOSO → CITTÀ');
          handleModeChange('city');
        }
      }
    });
  }

  function stopAcc(): void {
    accRef.current?.remove();
    accRef.current = null;
    accBuf.current = [];
  }

  // ── cambio modalità ───────────────────────────────────────
  async function handleModeChange(newMode: AppMode): Promise<void> {
    modeRef.current = newMode;
    setMode(newMode);
    const state = await loadState();
    state.mode = newMode;
    await saveState(state);

    if (newMode === 'rest') {
      // GPS off per risparmiare batteria
      await stopGps();
      Accelerometer.setUpdateInterval(1000 / ACC_HZ_REST);
    } else {
      await startGps(newMode);
      Accelerometer.setUpdateInterval(Math.round(1000 / (newMode === 'travel' ? ACC_HZ_TRAVEL : ACC_HZ_CITY)));
    }
  }

  // ── polling UI ────────────────────────────────────────────
  async function updateCity(): Promise<void> {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;
      // getLastKnownPositionAsync è istantanea, non richiede GPS attivo
      const pos = await Location.getLastKnownPositionAsync({ maxAge: 300_000 });
      if (!pos) return;
      const res = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (res.length > 0) {
        const r = res[0];
        const city = r.city || r.subregion || r.region;
        if (city) setCurrentCity(city);
      }
    } catch { /* ignora */ }
  }

  function startPolling(): void {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const [state, day] = await Promise.all([loadState(), loadDay()]);
      setMode(state.mode);
      setVehicleState(state.vehicleState);
      setSpeedKmh(Math.round(state.lastSpeedKmh));
      setTripDistM(state.tripDistanceM);
      setTripMaxSpd(Math.round(state.tripMaxSpeedKmh));
      setDayStops([...day.stops].reverse());
      setDayTrips([...day.trips].reverse());
      setLastSync(Date.now());
      modeRef.current = state.mode;
      await updateCity();
    }, UI_POLL_MS);
  }

  function stopPolling(): void {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  // ── START ─────────────────────────────────────────────────
  async function startTracking(): Promise<void> {
    const ok = await requestPermissions();
    if (!ok) return;

    const fresh = defaultState();
    fresh.isTracking = true;
    await saveState(fresh);
    await saveDay(defaultDay());

    await startGps('city');
    startAcc('city');
    modeRef.current = 'city';
    setIsTracking(true);
    updateCity();
    setMode('city');
    setVehicleState('stopped');
    setSpeedKmh(0);
    setTripDistM(0);
    setTripMaxSpd(0);
    setDayStops([]);
    setDayTrips([]);
    startPolling();
  }

  // ── STOP ──────────────────────────────────────────────────
  async function stopTracking(): Promise<void> {
    await stopGps();
    stopAcc();
    stopPolling();

    // Salva tragitto in corso se abbastanza lungo
    const state = await loadState();
    const day = await loadDay();
    if (state.tripId && state.tripDistanceM >= MIN_DIST_METERS) {
      const avg = state.tripSpeedCount > 0
        ? state.tripSpeedSum / state.tripSpeedCount : 0;
      day.trips.push({
        id: state.tripId,
        startTs: state.tripStartTs!,
        endTs: Date.now(),
        startLat: state.tripStartLat!,
        startLng: state.tripStartLng!,
        endLat: state.tripLastLat ?? state.tripStartLat!,
        endLng: state.tripLastLng ?? state.tripStartLng!,
        distanceMeters: state.tripDistanceM,
        avgSpeedKmh: Math.round(avg),
        maxSpeedKmh: Math.round(state.tripMaxSpeedKmh),
      });
      await saveDay(day);
    }

    state.isTracking = false;
    await saveState(state);

    const finalDay = await loadDay();
    setIsTracking(false);
    setMode('city');
    setVehicleState('stopped');
    setSpeedKmh(0);
    setTripDistM(0);
    setTripMaxSpd(0);
    setDayStops([...finalDay.stops].reverse());
    setDayTrips([...finalDay.trips].reverse());
  }

  // ── EXPORT ────────────────────────────────────────────────
  async function exportDay(): Promise<void> {
    const day = await loadDay();
    if (day.trips.length === 0 && day.stops.length === 0) {
      Alert.alert('Nessun dato', 'Avvia e ferma il tracking prima di esportare.');
      return;
    }
    const totalKm = day.trips.reduce((s, t) => s + t.distanceMeters, 0) / 1000;
    const totalStopSec = day.stops.reduce((s, st) => s + st.durationSec, 0);

    const payload = {
      app: 'Nexus Flow',
      exportedAt: new Date().toISOString(),
      date: day.date,
      sommario: {
        totalKm: parseFloat(totalKm.toFixed(2)),
        totaleSoste: day.stops.length,
        totaleTragitti: day.trips.length,
        tempoSosteSec: totalStopSec,
      },
      tragitti: day.trips.map(t => ({
        ...t,
        mapLink: `https://www.google.com/maps/dir/${t.startLat},${t.startLng}/${t.endLat},${t.endLng}`,
      })),
      soste: day.stops,
    };

    try {
      const fileName = `nexusflow_${day.date}.json`;
      const fileUri = FileSystem.cacheDirectory + fileName;
      await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(payload, null, 2), {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/json',
          dialogTitle: 'Salva o condividi la giornata',
          UTI: 'public.json',
        });
      } else {
        Alert.alert('Errore', 'Condivisione non disponibile su questo dispositivo.');
      }
    } catch (e: any) {
      Alert.alert('Errore export', e.message ?? 'Impossibile esportare il file.');
    }
  }

  // ── lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    // Riprendi se il tracking era già attivo (app riaperta)
    (async () => {
      const state = await loadState();
      if (state.isTracking) {
        const day = await loadDay();
        setIsTracking(true);
        setMode(state.mode);
        modeRef.current = state.mode;
        setDayStops([...day.stops].reverse());
        setDayTrips([...day.trips].reverse());
        startAcc(state.mode);
        startPolling();
      }
      // Rileva sempre la città al primo avvio
      updateCity();
    })();

    const sub = AppState.addEventListener('change', (_next: AppStateStatus) => {
      // Nessuna azione richiesta: il task BG gestisce tutto in background
    });

    return () => {
      stopPolling();
      stopAcc();
      sub.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── computed ──────────────────────────────────────────────
  const totalDayKm = dayTrips.reduce((s, t) => s + t.distanceMeters, 0) / 1000;
  const hasData    = dayTrips.length > 0 || dayStops.length > 0;

  const MODE_COLOR  = mode === 'rest' ? '#555' : mode === 'travel' ? '#00FF88' : '#FFA500';
  const MODE_LABEL  = mode === 'rest' ? 'RIPOSO' : mode === 'travel' ? 'VIAGGIO' : 'CITTÀ';
  const MODE_ICON   = mode === 'rest' ? '💤' : mode === 'travel' ? '🚛' : '🏙';

  const events = [
    ...dayStops.map(s => ({ type: 'stop' as const, ts: s.startTs, data: s })),
    ...dayTrips.map(t => ({ type: 'trip' as const, ts: t.startTs, data: t })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 8);

  // ── render ────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* HEADER */}
      <View style={s.header}>
        <Text style={s.logo}>NEXUS FLOW</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.cityLabel}>📍 {currentCity}</Text>
          <Text style={s.sync}>
            {lastSync ? `↺ ${fmtTime(lastSync)}` : '—'}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* MODALITÀ */}
        <View style={[s.card, s.modeCard]}>
          <Text style={s.modeEmoji}>{MODE_ICON}</Text>
          <Text style={[s.modeText, { color: MODE_COLOR }]}>{MODE_LABEL}</Text>
          {isTracking && (
            <Text style={s.speedBadge}>{speedKmh} km/h</Text>
          )}
        </View>

        {/* TRAGITTO IN CORSO */}
        {isTracking && vehicleState === 'moving' && (
          <View style={[s.card, s.tripLiveCard]}>
            <Text style={s.cardLabel}>TRAGITTO IN CORSO</Text>
            <View style={s.row}>
              <View style={s.statCell}>
                <Text style={s.statBig}>{fmtDist(tripDistM)}</Text>
                <Text style={s.statSub}>distanza</Text>
              </View>
              <View style={s.statCell}>
                <Text style={s.statBig}>{tripMaxSpd}</Text>
                <Text style={s.statSub}>km/h max</Text>
              </View>
            </View>
          </View>
        )}

        {/* RIEPILOGO GIORNATA */}
        <View style={s.card}>
          <Text style={s.cardLabel}>
            OGGI — {new Date().toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long' }).toUpperCase()}
          </Text>
          <View style={s.row}>
            <View style={s.statCell}>
              <Text style={s.statBig}>{totalDayKm.toFixed(1)}</Text>
              <Text style={s.statSub}>km totali</Text>
            </View>
            <View style={s.statCell}>
              <Text style={s.statBig}>{dayTrips.length}</Text>
              <Text style={s.statSub}>tragitti</Text>
            </View>
            <View style={s.statCell}>
              <Text style={s.statBig}>{dayStops.length}</Text>
              <Text style={s.statSub}>soste</Text>
            </View>
          </View>
        </View>

        {/* BOTTONE PRINCIPALE */}
        <TouchableOpacity
          style={[s.mainBtn, isTracking ? s.stopBtn : s.startBtn]}
          onPress={isTracking ? stopTracking : startTracking}
          activeOpacity={0.75}
        >
          <Text style={[s.mainBtnTxt, isTracking && s.stopBtnTxt]}>
            {isTracking ? '■  STOP TRACKING' : '▶  START TRACKING'}
          </Text>
        </TouchableOpacity>

        {/* EXPORT */}
        <TouchableOpacity
          style={[s.exportBtn, !hasData && s.exportBtnDisabled]}
          onPress={hasData ? exportDay : undefined}
        >
          <Text style={s.exportTxt}>↑  Esporta giornata (JSON + link mappa)</Text>
        </TouchableOpacity>

        {/* EVENTI */}
        {events.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardLabel}>ULTIMI EVENTI</Text>
            {events.map(ev =>
              ev.type === 'stop' ? (
                <View key={ev.data.id} style={s.evRow}>
                  <Text style={s.evIcon}>📍</Text>
                  <View style={s.evBody}>
                    <Text style={s.evTitle} numberOfLines={1}>
                      {(ev.data as StopRecord).address}
                    </Text>
                    <Text style={s.evSub}>
                      {fmtTime(ev.ts)} · {fmtDuration((ev.data as StopRecord).durationSec)}
                      {(ev.data as StopRecord).postalCode ? `  ·  CAP ${(ev.data as StopRecord).postalCode}` : ''}
                    </Text>
                  </View>
                </View>
              ) : (
                <View key={ev.data.id} style={s.evRow}>
                  <Text style={s.evIcon}>🛣</Text>
                  <View style={s.evBody}>
                    <Text style={s.evTitle}>
                      {fmtDist((ev.data as TripRecord).distanceMeters)}
                    </Text>
                    <Text style={s.evSub}>
                      {fmtTime(ev.ts)} · media {(ev.data as TripRecord).avgSpeedKmh} km/h · max {(ev.data as TripRecord).maxSpeedKmh} km/h
                    </Text>
                  </View>
                </View>
              )
            )}
          </View>
        )}

        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================
// STILI — tema OLED scuro
// ============================================================
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#111',
  },
  logo: {
    color: '#00FF88',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 4,
  },
  sync: {
    color: '#333',
    fontSize: 12,
  },
  scroll: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#0A0A0A',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#181818',
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 22,
    gap: 14,
  },
  modeEmoji: {
    fontSize: 30,
  },
  modeText: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 3,
  },
  speedBadge: {
    color: '#444',
    fontSize: 16,
    marginLeft: 4,
    alignSelf: 'flex-end',
    marginBottom: 4,
  },
  tripLiveCard: {
    borderColor: '#003322',
  },
  cardLabel: {
    color: '#333',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statCell: {
    alignItems: 'center',
  },
  statBig: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
  },
  statSub: {
    color: '#444',
    fontSize: 11,
    marginTop: 3,
  },
  mainBtn: {
    borderRadius: 16,
    paddingVertical: 22,
    alignItems: 'center',
    marginTop: 4,
  },
  startBtn: {
    backgroundColor: '#00FF88',
  },
  stopBtn: {
    backgroundColor: '#0A0A0A',
    borderWidth: 2,
    borderColor: '#FF3B30',
  },
  mainBtnTxt: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 3,
    color: '#000',
  },
  stopBtnTxt: {
    color: '#FF3B30',
  },
  exportBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#00FF88',
  },
  exportBtnDisabled: {
    borderColor: '#222',
    opacity: 0.4,
  },
  exportTxt: {
    color: '#00FF88',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
  cityLabel: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '500',
  },
  evRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    gap: 12,
  },
  evIcon: {
    fontSize: 18,
    marginTop: 1,
  },
  evBody: {
    flex: 1,
  },
  evTitle: {
    color: '#ddd',
    fontSize: 14,
    fontWeight: '600',
  },
  evSub: {
    color: '#444',
    fontSize: 12,
    marginTop: 3,
  },
});

registerRootComponent(App);
