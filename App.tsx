// ============================================================
// NEXUS FLOW — GPS Tracker Professionale per Camionisti
// ============================================================

import { registerRootComponent } from 'expo';
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Share,
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
// PALETTE COLORI
// ============================================================
const C = {
  bg:           '#0A0E1A',
  surface:      '#111827',
  surfaceLight: '#1C2537',
  border:       '#252F42',
  borderLight:  '#2E3B52',
  green:        '#22C55E',
  greenDim:     '#16A34A',
  orange:       '#F59E0B',
  orangeDim:    '#B45309',
  red:          '#EF4444',
  redDim:       '#B91C1C',
  blue:         '#3B82F6',
  blueDim:      '#1D4ED8',
  text:         '#F1F5F9',
  textSub:      '#94A3B8',
  textMuted:    '#475569',
  white:        '#FFFFFF',
};

// ============================================================
// COSTANTI CONFIGURABILI
// ============================================================
const STOP_SPEED_KMH         = 3;
const STOP_CONFIRM_SEC       = 60;
const STOP_IGNORE_SEC        = 30;
const MIN_DIST_METERS        = 80;
const TRAVEL_SPEED_KMH       = 15;

const GPS_INTERVAL_CITY_MS   = 12_000;
const GPS_INTERVAL_TRAVEL_MS = 4_000;
const GPS_DISTANCE_CITY_M    = 10;
const GPS_DISTANCE_TRAVEL_M  = 5;
const GPS_ACCURACY_LIMIT_M   = 120;  // più alto = funziona in tasca

const ACC_HZ_REST            = 1;
const ACC_HZ_CITY            = 5;
const ACC_HZ_TRAVEL          = 50;
const ACC_VARIANCE_THRESHOLD = 0.008;
const ACC_VARIANCE_WINDOW    = 20;

const UI_POLL_MS             = 2_000;

// Limiti EU conducente
const SPEED_LIMIT_KMH        = 90;
const EU_MAX_DRIVE_SEC       = 4.5 * 3600;   // 4h 30m
const EU_WARN_BEFORE_SEC     = 30 * 60;       // avvisa 30m prima

// ============================================================
// CHIAVI STORAGE & TASK
// ============================================================
const KEY_STATE = '@nf_state_v3';
const KEY_DAY   = '@nf_day_v3';
const BG_TASK   = 'nf-background-location';

// ============================================================
// TIPI
// ============================================================
type VehicleMode = 'rest' | 'city' | 'travel';

interface TrackingState {
  isTracking: boolean;
  mode: VehicleMode;
  sessionStartTs: number | null;
  tripStartTs: number | null;
  tripStartLat: number | null;
  tripStartLon: number | null;
  tripDistM: number;
  tripMaxSpeedKmh: number;
  lastLat: number | null;
  lastLon: number | null;
  lastTs: number | null;
  lastSpeedKmh: number;
  stopStartTs: number | null;
  continuousDriveStartTs: number | null;
  totalDriveSecToday: number;
  cityPollCount: number;
}

interface TripEvent {
  type: 'trip' | 'stop';
  startTs: number;
  endTs: number;
  durationSec: number;
  distKm?: number;
  maxSpeedKmh?: number;
  startCity?: string;
  endCity?: string;
}

interface DayData {
  date: string;
  totalKm: number;
  totalDriveSecToday: number;
  events: TripEvent[];
}

const DEFAULT_STATE: TrackingState = {
  isTracking: false,
  mode: 'rest',
  sessionStartTs: null,
  tripStartTs: null,
  tripStartLat: null,
  tripStartLon: null,
  tripDistM: 0,
  tripMaxSpeedKmh: 0,
  lastLat: null,
  lastLon: null,
  lastTs: null,
  lastSpeedKmh: 0,
  stopStartTs: null,
  continuousDriveStartTs: null,
  totalDriveSecToday: 0,
  cityPollCount: 0,
};

// ============================================================
// UTILITÀ
// ============================================================
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function fmtClock(): string {
  return new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function loadState(): Promise<TrackingState> {
  try {
    const s = await AsyncStorage.getItem(KEY_STATE);
    if (s) return { ...DEFAULT_STATE, ...JSON.parse(s) };
  } catch {}
  return { ...DEFAULT_STATE };
}

async function saveState(s: TrackingState): Promise<void> {
  try { await AsyncStorage.setItem(KEY_STATE, JSON.stringify(s)); } catch {}
}

async function loadDay(): Promise<DayData> {
  try {
    const raw = await AsyncStorage.getItem(KEY_DAY);
    if (raw) {
      const d: DayData = JSON.parse(raw);
      if (d.date === todayStr()) return d;
    }
  } catch {}
  return { date: todayStr(), totalKm: 0, totalDriveSecToday: 0, events: [] };
}

async function saveDay(d: DayData): Promise<void> {
  try { await AsyncStorage.setItem(KEY_DAY, JSON.stringify(d)); } catch {}
}

// ============================================================
// TASK BACKGROUND GPS
// ============================================================
TaskManager.defineTask(BG_TASK, async ({ data, error }: any) => {
  if (error || !data?.locations?.length) return;
  const loc: Location.LocationObject = data.locations[data.locations.length - 1];
  if (loc.coords.accuracy !== null && loc.coords.accuracy > GPS_ACCURACY_LIMIT_M) return;

  const state = await loadState();
  if (!state.isTracking) return;

  const now = Date.now();
  const lat = loc.coords.latitude;
  const lon = loc.coords.longitude;
  const speedMs = loc.coords.speed ?? 0;
  const speedKmh = Math.max(0, speedMs * 3.6);

  let s = { ...state, lastSpeedKmh: speedKmh };

  if (s.lastLat !== null && s.lastLon !== null && s.lastTs !== null) {
    const dist = haversineM(s.lastLat, s.lastLon, lat, lon);
    const elapsed = (now - s.lastTs) / 1000;

    if (speedKmh > STOP_SPEED_KMH) {
      // In movimento
      if (s.mode !== 'travel') s.mode = speedKmh >= TRAVEL_SPEED_KMH ? 'travel' : 'city';
      s.stopStartTs = null;

      if (s.tripStartTs === null) {
        s.tripStartTs = now;
        s.tripStartLat = lat;
        s.tripStartLon = lon;
        s.tripDistM = 0;
        s.tripMaxSpeedKmh = 0;
        if (s.continuousDriveStartTs === null) s.continuousDriveStartTs = now;
      }
      s.tripDistM += dist;
      if (speedKmh > s.tripMaxSpeedKmh) s.tripMaxSpeedKmh = speedKmh;

      // Accumula tempo di guida
      s.totalDriveSecToday += elapsed;

    } else {
      // Fermo
      if (s.stopStartTs === null) s.stopStartTs = now;
      const stopDur = (now - s.stopStartTs) / 1000;

      if (stopDur >= STOP_CONFIRM_SEC && s.tripStartTs !== null) {
        // Sosta confermata — chiudi il tragitto corrente
        if (s.tripDistM >= MIN_DIST_METERS) {
          const day = await loadDay();
          const tripKm = s.tripDistM / 1000;
          const driveSec = (s.stopStartTs - s.tripStartTs) / 1000;
          const ev: TripEvent = {
            type: 'trip',
            startTs: s.tripStartTs,
            endTs: s.stopStartTs,
            durationSec: driveSec,
            distKm: Math.round(tripKm * 10) / 10,
            maxSpeedKmh: Math.round(s.tripMaxSpeedKmh),
          };
          day.events.push(ev);
          day.totalKm = Math.round((day.totalKm + tripKm) * 10) / 10;
          day.totalDriveSecToday = s.totalDriveSecToday;
          await saveDay(day);
        }
        s.tripStartTs = null;
        s.tripStartLat = null;
        s.tripStartLon = null;
        s.tripDistM = 0;
        s.tripMaxSpeedKmh = 0;
        s.continuousDriveStartTs = null;
        s.mode = 'city';
      }

      if (stopDur >= REST_INACTIVITY_MIN * 60) s.mode = 'rest';
    }
  }

  s.lastLat = lat;
  s.lastLon = lon;
  s.lastTs = now;
  s.cityPollCount = (s.cityPollCount || 0) + 1;

  await saveState(s);
});

const REST_INACTIVITY_MIN = 5;

// ============================================================
// FUNZIONI GPS
// ============================================================
async function startGps(mode: VehicleMode): Promise<void> {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== 'granted') throw new Error('Permesso posizione negato');
  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== 'granted') throw new Error('Permesso posizione background negato');

  const isRunning = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(() => false);
  if (isRunning) await Location.stopLocationUpdatesAsync(BG_TASK).catch(() => {});

  const travel = mode === 'travel';
  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: travel ? Location.Accuracy.BestForNavigation : Location.Accuracy.High,
    timeInterval: travel ? GPS_INTERVAL_TRAVEL_MS : GPS_INTERVAL_CITY_MS,
    distanceInterval: travel ? GPS_DISTANCE_TRAVEL_M : GPS_DISTANCE_CITY_M,
    foregroundService: {
      notificationTitle: 'Nexus Flow — Tracking Attivo',
      notificationBody: 'Registrazione percorso in corso',
      notificationColor: '#22C55E',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

async function stopGps(): Promise<void> {
  const isRunning = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(() => false);
  if (isRunning) await Location.stopLocationUpdatesAsync(BG_TASK).catch(() => {});
}

// ============================================================
// COMPONENTE PRINCIPALE
// ============================================================
function App(): React.JSX.Element {
  const [state, setState] = useState<TrackingState>({ ...DEFAULT_STATE });
  const [day, setDay] = useState<DayData>({ date: todayStr(), totalKm: 0, totalDriveSecToday: 0, events: [] });
  const [currentCity, setCurrentCity] = useState<string>('—');
  const [clock, setClock] = useState<string>(fmtClock());
  const [loading, setLoading] = useState<boolean>(true);
  const [mapRegion, setMapRegion] = useState({ latitude: 41.9, longitude: 12.5, latitudeDelta: 0.02, longitudeDelta: 0.02 });
  const routeCoords = useRef<{ latitude: number; longitude: number }[]>([]);

  const appState = useRef<AppStateStatus>(AppState.currentState);
  const accSubscription = useRef<any>(null);
  const accSamples = useRef<number[]>([]);
  const fgWatcher = useRef<Location.LocationSubscription | null>(null);
  const fgLastLat = useRef<number | null>(null);
  const fgLastLon = useRef<number | null>(null);

  // ── Tick dell'orologio ─────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setClock(fmtClock()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Inizializzazione & polling ─────────────────────────────
  useEffect(() => {
    let pollId: ReturnType<typeof setInterval>;

    (async () => {
      const s = await loadState();
      const d = await loadDay();
      setState(s);
      setDay(d);
      setLoading(false);

      if (s.isTracking) {
        await startGps(s.mode).catch(() => {});
        startAccelerometer(s.mode);
        startFgWatcher();
        updateCity();
      }

      pollId = setInterval(async () => {
        const ns = await loadState();
        const nd = await loadDay();
        setState(ns);
        setDay(nd);
      }, UI_POLL_MS);
    })();

    const sub = AppState.addEventListener('change', async (next: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        const ns = await loadState();
        if (ns.isTracking) updateCity();
      }
      appState.current = next;
    });

    return () => {
      clearInterval(pollId);
      sub.remove();
      stopAccelerometer();
      stopFgWatcher();
    };
  }, []);

  // ── Watcher foreground (aggiornamenti 1s in tempo reale) ──
  async function startFgWatcher(): Promise<void> {
    stopFgWatcher();
    fgLastLat.current = null;
    fgLastLon.current = null;
    try {
      fgWatcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 1 },
        (loc) => {
          const speedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
          const lat = loc.coords.latitude;
          const lon = loc.coords.longitude;

          // Aggiorna mappa
          setMapRegion({ latitude: lat, longitude: lon, latitudeDelta: 0.008, longitudeDelta: 0.008 });
          routeCoords.current = [...routeCoords.current, { latitude: lat, longitude: lon }];
          if (routeCoords.current.length > 1000) routeCoords.current = routeCoords.current.slice(-500);

          setState(prev => {
            if (!prev.isTracking) return prev;
            let addedDist = 0;
            if (fgLastLat.current !== null && fgLastLon.current !== null) {
              addedDist = haversineM(fgLastLat.current, fgLastLon.current, lat, lon);
            }
            fgLastLat.current = lat;
            fgLastLon.current = lon;
            const newTripDist = speedKmh > STOP_SPEED_KMH
              ? prev.tripDistM + addedDist
              : prev.tripDistM;
            const newMaxSpeed = speedKmh > prev.tripMaxSpeedKmh ? speedKmh : prev.tripMaxSpeedKmh;
            return {
              ...prev,
              lastSpeedKmh: speedKmh,
              lastLat: lat,
              lastLon: lon,
              tripDistM: newTripDist,
              tripMaxSpeedKmh: prev.tripStartTs !== null ? newMaxSpeed : prev.tripMaxSpeedKmh,
            };
          });
        }
      );
    } catch {}
  }

  function stopFgWatcher(): void {
    fgWatcher.current?.remove();
    fgWatcher.current = null;
  }

  // ── Accelerometro ─────────────────────────────────────────
  function startAccelerometer(mode: VehicleMode): void {
    stopAccelerometer();
    const hz = mode === 'rest' ? ACC_HZ_REST : mode === 'city' ? ACC_HZ_CITY : ACC_HZ_TRAVEL;
    Accelerometer.setUpdateInterval(Math.floor(1000 / hz));
    accSubscription.current = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      accSamples.current.push(magnitude);
      if (accSamples.current.length > ACC_VARIANCE_WINDOW) accSamples.current.shift();
    });
  }

  function stopAccelerometer(): void {
    accSubscription.current?.remove();
    accSubscription.current = null;
    accSamples.current = [];
  }

  // ── Città ──────────────────────────────────────────────────
  async function updateCity(): Promise<void> {
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync();
        status = req.status;
      }
      if (status !== 'granted') return;
      let pos = await Location.getLastKnownPositionAsync();
      if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      if (!pos) return;
      const res = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      if (res.length > 0) {
        const r = res[0];
        const city = r.city || r.subregion || r.region;
        if (city) setCurrentCity(city);
      }
    } catch {}
  }

  // ── Avvio / Stop tracking ─────────────────────────────────
  async function handleStartStop(): Promise<void> {
    if (state.isTracking) {
      // STOP
      await stopGps();
      stopAccelerometer();
      stopFgWatcher();
      const now = Date.now();

      const ns: TrackingState = {
        ...state,
        isTracking: false,
        mode: 'rest',
        tripStartTs: null,
        tripStartLat: null,
        tripStartLon: null,
        tripDistM: 0,
        tripMaxSpeedKmh: 0,
        stopStartTs: null,
        continuousDriveStartTs: null,
        sessionStartTs: null,
      };

      // Salva eventuale tragitto in corso
      if (state.tripStartTs !== null && state.tripDistM >= MIN_DIST_METERS) {
        const d = await loadDay();
        const tripKm = state.tripDistM / 1000;
        const ev: TripEvent = {
          type: 'trip',
          startTs: state.tripStartTs,
          endTs: now,
          durationSec: (now - state.tripStartTs) / 1000,
          distKm: Math.round(tripKm * 10) / 10,
          maxSpeedKmh: Math.round(state.tripMaxSpeedKmh),
        };
        d.events.push(ev);
        d.totalKm = Math.round((d.totalKm + tripKm) * 10) / 10;
        d.totalDriveSecToday = ns.totalDriveSecToday;
        await saveDay(d);
        setDay(d);
      }

      await saveState(ns);
      setState(ns);
    } else {
      // START
      try {
        routeCoords.current = [];
        await startGps('city');
        startAccelerometer('city');
        startFgWatcher();
        const ns: TrackingState = {
          ...DEFAULT_STATE,
          isTracking: true,
          mode: 'city',
          sessionStartTs: Date.now(),
          totalDriveSecToday: state.totalDriveSecToday,
        };
        await saveState(ns);
        setState(ns);
        updateCity();
      } catch (e: any) {
        Alert.alert('Errore permessi', e?.message ?? 'Impossibile avviare il tracking');
      }
    }
  }

  // ── Export giornata ───────────────────────────────────────
  async function exportDay(): Promise<void> {
    const d = await loadDay();
    if (!d.events.length) {
      Alert.alert('Nessun dato', 'Non ci sono viaggi registrati oggi.');
      return;
    }
    const lines: string[] = [
      `NEXUS FLOW — Resoconto ${d.date}`,
      `────────────────────────────────`,
      `Distanza totale: ${d.totalKm} km`,
      `Tempo guida: ${fmtDuration(d.totalDriveSecToday)}`,
      `Viaggi: ${d.events.filter(e => e.type === 'trip').length}`,
      ``,
      `DETTAGLIO VIAGGI`,
      `────────────────────────────────`,
    ];
    d.events.forEach((ev, i) => {
      if (ev.type === 'trip') {
        lines.push(`Viaggio ${i + 1}`);
        lines.push(`  Inizio: ${fmtTime(ev.startTs)}   Fine: ${fmtTime(ev.endTs)}`);
        lines.push(`  Distanza: ${ev.distKm} km   Max: ${ev.maxSpeedKmh} km/h`);
        lines.push(`  Durata: ${fmtDuration(ev.durationSec)}`);
        lines.push(``);
      }
    });
    await Share.share({ message: lines.join('\n'), title: `Nexus Flow ${d.date}` });
  }

  // ── Calcolo valori live ────────────────────────────────────
  const now = Date.now();
  const sessionSec = state.sessionStartTs ? (now - state.sessionStartTs) / 1000 : 0;
  const currentTripKm = state.tripDistM / 1000;
  const totalDriveSec = state.totalDriveSecToday;

  // Guida continua
  const contDriveSec = state.continuousDriveStartTs
    ? (now - state.continuousDriveStartTs) / 1000
    : 0;
  const timeToBreakSec = Math.max(0, EU_MAX_DRIVE_SEC - contDriveSec);
  const euWarn = contDriveSec >= EU_MAX_DRIVE_SEC - EU_WARN_BEFORE_SEC;
  const euAlert = contDriveSec >= EU_MAX_DRIVE_SEC;

  // Speed alert
  const speedAlert = state.lastSpeedKmh > SPEED_LIMIT_KMH;

  const modeLabel = { rest: 'RIPOSO', city: 'CITTÀ', travel: 'VIAGGIO' }[state.mode];
  const modeColor = { rest: C.textMuted, city: C.blue, travel: C.green }[state.mode];

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={[s.center, { flex: 1 }]}>
          <Text style={[s.label, { color: C.green, fontSize: 18 }]}>NEXUS FLOW</Text>
          <Text style={[s.label, { color: C.textMuted, marginTop: 8 }]}>Caricamento…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── HEADER ── */}
      <View style={s.header}>
        <View>
          <Text style={s.appTitle}>NEXUS FLOW</Text>
          <Text style={s.appSub}>GPS Tracker Professionale</Text>
        </View>
        <View style={s.headerRight}>
          <Text style={s.clock}>{clock}</Text>
          <Text style={[s.cityChip]}>{currentCity}</Text>
        </View>
      </View>

      {/* ── ALERT VELOCITÀ ── */}
      {speedAlert && (
        <View style={[s.alertBar, { backgroundColor: C.red }]}>
          <Text style={s.alertBarText}>
            ⚠ VELOCITÀ ELEVATA — {Math.round(state.lastSpeedKmh)} km/h  (limite {SPEED_LIMIT_KMH} km/h)
          </Text>
        </View>
      )}

      {/* ── ALERT EU GUIDA ── */}
      {euAlert && (
        <View style={[s.alertBar, { backgroundColor: C.red }]}>
          <Text style={s.alertBarText}>
            🛑 PAUSA OBBLIGATORIA — Limite UE di 4h 30m raggiunto!
          </Text>
        </View>
      )}
      {!euAlert && euWarn && state.isTracking && (
        <View style={[s.alertBar, { backgroundColor: C.orange }]}>
          <Text style={s.alertBarText}>
            ⏰ PAUSA TRA {fmtDuration(timeToBreakSec)} — Norma UE tempi guida
          </Text>
        </View>
      )}

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── CARD STATO & VELOCITÀ ── */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={s.cardLabel}>MODALITÀ</Text>
              <Text style={[s.modeBadge, { color: modeColor }]}>{modeLabel}</Text>
              {state.isTracking && (
                <Text style={s.cardSub}>Sessione: {fmtDuration(sessionSec)}</Text>
              )}
            </View>
            <View style={s.speedBox}>
              <Text style={[s.speedNum, { color: speedAlert ? C.red : C.green }]}>
                {Math.round(state.lastSpeedKmh)}
              </Text>
              <Text style={s.speedUnit}>km/h</Text>
            </View>
          </View>
        </View>

        {/* ── CARD TEMPI DI GUIDA (EU) ── */}
        {state.isTracking && (
          <View style={s.card}>
            <Text style={s.cardLabel}>TEMPI DI GUIDA — NORMA UE</Text>
            <View style={s.rowBetween}>
              <View style={s.statCol}>
                <Text style={s.statVal}>{fmtDuration(contDriveSec)}</Text>
                <Text style={s.statKey}>Guida continua</Text>
              </View>
              <View style={s.statCol}>
                <Text style={[s.statVal, euAlert ? { color: C.red } : euWarn ? { color: C.orange } : {}]}>
                  {euAlert ? 'PAUSA!' : fmtDuration(timeToBreakSec)}
                </Text>
                <Text style={s.statKey}>Alla pausa</Text>
              </View>
              <View style={s.statCol}>
                <Text style={s.statVal}>{fmtDuration(totalDriveSec)}</Text>
                <Text style={s.statKey}>Totale oggi</Text>
              </View>
            </View>
            {/* Barra progresso guida continua */}
            <View style={s.progressBg}>
              <View
                style={[
                  s.progressFill,
                  {
                    width: `${Math.min(100, (contDriveSec / EU_MAX_DRIVE_SEC) * 100)}%` as any,
                    backgroundColor: euAlert ? C.red : euWarn ? C.orange : C.green,
                  },
                ]}
              />
            </View>
            <Text style={s.progressLabel}>
              {Math.round((contDriveSec / EU_MAX_DRIVE_SEC) * 100)}% del limite UE (4h 30m)
            </Text>
          </View>
        )}

        {/* ── CARD VIAGGIO IN CORSO ── */}
        {state.tripStartTs !== null && (
          <View style={[s.card, { borderColor: C.green, borderWidth: 1 }]}>
            <Text style={[s.cardLabel, { color: C.green }]}>VIAGGIO IN CORSO</Text>
            <View style={s.rowBetween}>
              <View style={s.statCol}>
                <Text style={s.statVal}>{currentTripKm.toFixed(1)} km</Text>
                <Text style={s.statKey}>Distanza</Text>
              </View>
              <View style={s.statCol}>
                <Text style={s.statVal}>{Math.round(state.tripMaxSpeedKmh)} km/h</Text>
                <Text style={s.statKey}>Max velocità</Text>
              </View>
              <View style={s.statCol}>
                <Text style={s.statVal}>{fmtDuration((now - state.tripStartTs) / 1000)}</Text>
                <Text style={s.statKey}>Durata</Text>
              </View>
            </View>
            <Text style={[s.cardSub, { marginTop: 4 }]}>
              Partenza: {fmtTime(state.tripStartTs)}
            </Text>
          </View>
        )}

        {/* ── MAPPA (disponibile dopo nuova build) ── */}
        <View style={[s.mapCard, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ color: C.textMuted, fontSize: 13, fontWeight: '700' }}>MAPPA IN TEMPO REALE</Text>
          <Text style={{ color: C.textMuted, fontSize: 11, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 }}>
            Disponibile dopo la prossima build{'\n'}( eas build --platform android --profile preview )
          </Text>
          {state.lastLat !== null && (
            <Text style={{ color: C.blue, fontSize: 11, marginTop: 8 }}>
              {state.lastLat?.toFixed(5)}, {state.lastLon?.toFixed(5)}
            </Text>
          )}
        </View>

        {/* ── CARD RIEPILOGO GIORNATA ── */}
        <View style={s.card}>
          <Text style={s.cardLabel}>GIORNATA — {day.date}</Text>
          <View style={s.rowBetween}>
            <View style={s.statCol}>
              <Text style={s.statVal}>{day.totalKm} km</Text>
              <Text style={s.statKey}>Percorsi</Text>
            </View>
            <View style={s.statCol}>
              <Text style={s.statVal}>{day.events.filter(e => e.type === 'trip').length}</Text>
              <Text style={s.statKey}>Viaggi</Text>
            </View>
            <View style={s.statCol}>
              <Text style={s.statVal}>{fmtDuration(totalDriveSec)}</Text>
              <Text style={s.statKey}>Tempo guida</Text>
            </View>
          </View>
        </View>

        {/* ── PULSANTE START / STOP ── */}
        <TouchableOpacity
          style={[s.mainBtn, { backgroundColor: state.isTracking ? C.redDim : C.greenDim }]}
          onPress={handleStartStop}
          activeOpacity={0.8}
        >
          <Text style={s.mainBtnText}>
            {state.isTracking ? '⏹  FERMA TRACKING' : '▶  AVVIA TRACKING'}
          </Text>
        </TouchableOpacity>

        {/* ── PULSANTE EXPORT ── */}
        <TouchableOpacity style={s.exportBtn} onPress={exportDay} activeOpacity={0.8}>
          <Text style={s.exportBtnText}>↑  ESPORTA GIORNATA</Text>
        </TouchableOpacity>


        {/* ── LISTA EVENTI ── */}
        {day.events.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardLabel}>EVENTI REGISTRATI</Text>
            {[...day.events].reverse().map((ev, idx) => (
              <View key={idx} style={s.eventRow}>
                <View style={[s.eventDot, { backgroundColor: ev.type === 'trip' ? C.green : C.orange }]} />
                <View style={{ flex: 1 }}>
                  <View style={s.rowBetween}>
                    <Text style={s.eventTitle}>
                      {ev.type === 'trip'
                        ? `Viaggio — ${ev.distKm} km`
                        : `Sosta`}
                    </Text>
                    <Text style={s.eventTime}>
                      {fmtTime(ev.startTs)} → {fmtTime(ev.endTs)}
                    </Text>
                  </View>
                  {ev.type === 'trip' && (
                    <Text style={s.eventSub}>
                      Max {ev.maxSpeedKmh} km/h · {fmtDuration(ev.durationSec)}
                    </Text>
                  )}
                  {ev.type === 'stop' && (
                    <Text style={s.eventSub}>{fmtDuration(ev.durationSec)}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================
// STILI
// ============================================================
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingTop: 8 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.surface,
  },
  appTitle: { fontSize: 20, fontWeight: '800', color: C.green, letterSpacing: 2 },
  appSub:   { fontSize: 10, color: C.textMuted, letterSpacing: 1, marginTop: 1 },
  headerRight: { alignItems: 'flex-end' },
  clock: { fontSize: 18, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] },
  cityChip: { fontSize: 12, color: C.blue, marginTop: 2 },

  // Alert bar
  alertBar: { paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center' },
  alertBarText: { color: C.white, fontWeight: '700', fontSize: 13, textAlign: 'center' },

  // Card
  card: {
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 12,
  },
  cardLabel: { fontSize: 10, color: C.textMuted, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },
  cardSub:   { fontSize: 12, color: C.textSub, marginTop: 2 },

  // Modalità & velocità
  modeBadge: { fontSize: 26, fontWeight: '800', letterSpacing: 1 },
  speedBox: { alignItems: 'center' },
  speedNum: { fontSize: 52, fontWeight: '900', lineHeight: 58, fontVariant: ['tabular-nums'] },
  speedUnit: { fontSize: 14, color: C.textSub, marginTop: -4 },

  // Stats
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  statCol:    { alignItems: 'center', flex: 1 },
  statVal:    { fontSize: 18, fontWeight: '700', color: C.text },
  statKey:    { fontSize: 10, color: C.textMuted, marginTop: 2, textAlign: 'center' },

  // Progress bar
  progressBg:   { height: 6, backgroundColor: C.border, borderRadius: 3, marginTop: 12, overflow: 'hidden' },
  progressFill:  { height: 6, borderRadius: 3 },
  progressLabel: { fontSize: 11, color: C.textMuted, marginTop: 4 },

  // Buttons
  mainBtn: {
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: C.green,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  mainBtnText: { fontSize: 18, fontWeight: '800', color: C.white, letterSpacing: 1 },
  exportBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 14,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceLight,
  },
  exportBtnText: { fontSize: 15, fontWeight: '700', color: C.blue, letterSpacing: 0.5 },

  // Events
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    gap: 10,
  },
  eventDot:   { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  eventTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  eventTime:  { fontSize: 11, color: C.textMuted },
  eventSub:   { fontSize: 12, color: C.textSub, marginTop: 2 },

  label: { fontSize: 14, color: C.text },

  // Mappa
  mapCard: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 12,
    height: 300,
  },
  map: { flex: 1 },
});

registerRootComponent(App);
export default App;
