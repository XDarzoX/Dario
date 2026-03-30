// ============================================================
// NEXUS FLOW — GPS Tracker Professionale per Camionisti
// ============================================================

import { registerRootComponent } from 'expo';
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Alert, Share, StatusBar, SafeAreaView, AppState, AppStateStatus,
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Accelerometer } from 'expo-sensors';

// ============================================================
// COLORI
// ============================================================
const C = {
  bg:          '#0A0E1A',
  surface:     '#111827',
  surfaceAlt:  '#1C2537',
  border:      '#252F42',
  green:       '#22C55E',
  greenDark:   '#16A34A',
  orange:      '#F59E0B',
  red:         '#EF4444',
  redDark:     '#B91C1C',
  blue:        '#3B82F6',
  text:        '#F1F5F9',
  sub:         '#94A3B8',
  muted:       '#475569',
  white:       '#FFFFFF',
};

// ============================================================
// COSTANTI
// ============================================================
const STOP_SPEED_KMH        = 3;
const STOP_CONFIRM_SEC      = 60;
const MIN_DIST_METERS       = 80;
const TRAVEL_SPEED_KMH      = 15;
const REST_INACTIVITY_MIN   = 5;

const GPS_INTERVAL_CITY_MS  = 10_000;
const GPS_INTERVAL_MOVE_MS  = 3_000;
const GPS_DIST_CITY_M       = 10;
const GPS_DIST_MOVE_M       = 5;
const GPS_ACCURACY_MAX_M    = 150;

const SPEED_LIMIT_KMH       = 90;
const EU_MAX_DRIVE_SEC      = 4.5 * 3600;
const EU_WARN_SEC           = 30 * 60;

const KEY_STATE             = '@nf_state_v4';
const KEY_DAY               = '@nf_day_v4';
const BG_TASK               = 'nf-bg-loc';

// ============================================================
// TIPI
// ============================================================
type Mode = 'rest' | 'city' | 'travel';

interface State {
  isTracking:           boolean;
  mode:                 Mode;
  sessionStartTs:       number | null;
  tripStartTs:          number | null;
  tripDistM:            number;
  tripMaxKmh:           number;
  lastLat:              number | null;
  lastLon:              number | null;
  lastTs:               number | null;
  speedKmh:             number;
  stopStartTs:          number | null;
  contDriveStartTs:     number | null;
  totalDriveSecToday:   number;
}

interface Trip {
  startTs:    number;
  endTs:      number;
  durSec:     number;
  distKm:     number;
  maxKmh:     number;
}

interface Day {
  date:             string;
  totalKm:          number;
  totalDriveSec:    number;
  trips:            Trip[];
}

const BLANK: State = {
  isTracking: false, mode: 'rest',
  sessionStartTs: null, tripStartTs: null,
  tripDistM: 0, tripMaxKmh: 0,
  lastLat: null, lastLon: null, lastTs: null,
  speedKmh: 0, stopStartTs: null,
  contDriveStartTs: null, totalDriveSecToday: 0,
};

// ============================================================
// UTILS
// ============================================================
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dl = ((lat2 - lat1) * Math.PI) / 180;
  const do_ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dl / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(do_ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const today = () => new Date().toISOString().slice(0, 10);
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const fmtClock = () => new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function loadState(): Promise<State> {
  try { const r = await AsyncStorage.getItem(KEY_STATE); if (r) return { ...BLANK, ...JSON.parse(r) }; } catch {}
  return { ...BLANK };
}
async function saveState(s: State) {
  try { await AsyncStorage.setItem(KEY_STATE, JSON.stringify(s)); } catch {}
}
async function loadDay(): Promise<Day> {
  try {
    const r = await AsyncStorage.getItem(KEY_DAY);
    if (r) { const d: Day = JSON.parse(r); if (d.date === today()) return d; }
  } catch {}
  return { date: today(), totalKm: 0, totalDriveSec: 0, trips: [] };
}
async function saveDay(d: Day) {
  try { await AsyncStorage.setItem(KEY_DAY, JSON.stringify(d)); } catch {}
}

// ============================================================
// BACKGROUND TASK
// ============================================================
TaskManager.defineTask(BG_TASK, async ({ data, error }: any) => {
  if (error || !data?.locations?.length) return;
  const loc: Location.LocationObject = data.locations[data.locations.length - 1];
  if (loc.coords.accuracy !== null && loc.coords.accuracy > GPS_ACCURACY_MAX_M) return;

  const s = await loadState();
  if (!s.isTracking) return;

  const now = Date.now();
  const lat = loc.coords.latitude;
  const lon = loc.coords.longitude;
  const kmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
  const ns: State = { ...s, speedKmh: kmh, lastLat: lat, lastLon: lon, lastTs: now };

  if (s.lastLat !== null && s.lastLon !== null && s.lastTs !== null) {
    const dist = haversine(s.lastLat, s.lastLon, lat, lon);
    const elapsed = (now - s.lastTs) / 1000;

    if (kmh > STOP_SPEED_KMH) {
      ns.mode = kmh >= TRAVEL_SPEED_KMH ? 'travel' : 'city';
      ns.stopStartTs = null;
      ns.totalDriveSecToday = s.totalDriveSecToday + elapsed;
      if (ns.contDriveStartTs === null) ns.contDriveStartTs = now;
      if (ns.tripStartTs === null) {
        ns.tripStartTs = now; ns.tripDistM = 0; ns.tripMaxKmh = 0;
      }
      ns.tripDistM = s.tripDistM + dist;
      ns.tripMaxKmh = Math.max(s.tripMaxKmh, kmh);
    } else {
      if (ns.stopStartTs === null) ns.stopStartTs = now;
      const stopSec = (now - ns.stopStartTs) / 1000;
      if (stopSec >= STOP_CONFIRM_SEC && ns.tripStartTs !== null && ns.tripDistM >= MIN_DIST_METERS) {
        const day = await loadDay();
        const km = Math.round((ns.tripDistM / 1000) * 10) / 10;
        day.trips.push({
          startTs: ns.tripStartTs, endTs: ns.stopStartTs!,
          durSec: (ns.stopStartTs! - ns.tripStartTs) / 1000,
          distKm: km, maxKmh: Math.round(ns.tripMaxKmh),
        });
        day.totalKm = Math.round((day.totalKm + km) * 10) / 10;
        day.totalDriveSec = ns.totalDriveSecToday;
        await saveDay(day);
        ns.tripStartTs = null; ns.tripDistM = 0; ns.tripMaxKmh = 0;
        ns.contDriveStartTs = null;
      }
      if (stopSec >= REST_INACTIVITY_MIN * 60) { ns.mode = 'rest'; }
    }
  }

  await saveState(ns);
});

// ============================================================
// GPS START / STOP
// ============================================================
async function startGps(mode: Mode): Promise<void> {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== 'granted') throw new Error('Permesso posizione negato');
  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== 'granted') throw new Error('Permesso posizione background negato');
  const running = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(BG_TASK).catch(() => {});
  const travel = mode === 'travel';
  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: travel ? Location.Accuracy.BestForNavigation : Location.Accuracy.High,
    timeInterval: travel ? GPS_INTERVAL_MOVE_MS : GPS_INTERVAL_CITY_MS,
    distanceInterval: travel ? GPS_DIST_MOVE_M : GPS_DIST_CITY_M,
    foregroundService: {
      notificationTitle: 'Nexus Flow — Tracking Attivo',
      notificationBody: 'GPS attivo — registrazione percorso in corso',
      notificationColor: '#22C55E',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

async function stopGps(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(BG_TASK).catch(() => {});
}

// ============================================================
// APP
// ============================================================
function App(): React.JSX.Element {
  const [st, setSt]         = useState<State>({ ...BLANK });
  const [day, setDay]       = useState<Day>({ date: today(), totalKm: 0, totalDriveSec: 0, trips: [] });
  const [city, setCity]     = useState('—');
  const [clock, setClock]   = useState(fmtClock());
  const [loading, setLoading] = useState(true);

  // mappa
  const route = useRef<{ latitude: number; longitude: number }[]>([]);
  const [routeSnap, setRouteSnap] = useState<{ latitude: number; longitude: number }[]>([]);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const accSub      = useRef<any>(null);
  const fgWatcher   = useRef<Location.LocationSubscription | null>(null);
  const prevLat     = useRef<number | null>(null);
  const prevLon     = useRef<number | null>(null);
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // orologio
  useEffect(() => {
    const id = setInterval(() => setClock(fmtClock()), 1000);
    return () => clearInterval(id);
  }, []);

  // init
  useEffect(() => {
    (async () => {
      const s = await loadState();
      const d = await loadDay();
      setSt(s); setDay(d); setLoading(false);
      if (s.isTracking) {
        await startGps(s.mode).catch(() => {});
        startAcc(s.mode);
        await startFg();
        doCity();
      }
    })();
    pollRef.current = setInterval(async () => {
      const s = await loadState(); const d = await loadDay();
      setSt(s); setDay(d);
    }, 2000);
    const sub = AppState.addEventListener('change', async (next: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        const s = await loadState(); if (s.isTracking) doCity();
      }
      appStateRef.current = next;
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      sub.remove(); stopAcc(); stopFg();
    };
  }, []);

  // ── Accelerometro ──────────────────────────────────────────
  function startAcc(mode: Mode) {
    stopAcc();
    const hz = mode === 'rest' ? 1 : mode === 'city' ? 5 : 50;
    Accelerometer.setUpdateInterval(Math.floor(1000 / hz));
    accSub.current = Accelerometer.addListener(() => {});
  }
  function stopAcc() { accSub.current?.remove(); accSub.current = null; }

  // ── Foreground watcher (velocità + mappa 1s) ────────────────
  async function startFg() {
    stopFg();
    prevLat.current = null; prevLon.current = null;
    try {
      fgWatcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
        (loc) => {
          const lat = loc.coords.latitude;
          const lon = loc.coords.longitude;
          const kmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
          // aggiorna velocità live + coordinate
          setSt(prev => ({ ...prev, speedKmh: kmh, lastLat: lat, lastLon: lon }));
          // aggiorna mappa
          route.current = [...route.current, { latitude: lat, longitude: lon }];
          if (route.current.length > 800) route.current = route.current.slice(-400);
          setRouteSnap([...route.current]);
        }
      );
    } catch {}
  }
  function stopFg() { fgWatcher.current?.remove(); fgWatcher.current = null; }

  // ── Città ───────────────────────────────────────────────────
  async function doCity() {
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') ({ status } = await Location.requestForegroundPermissionsAsync());
      if (status !== 'granted') return;
      let pos = await Location.getLastKnownPositionAsync();
      if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      if (!pos) return;
      const res = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      if (res.length > 0) {
        const c = res[0].city || res[0].subregion || res[0].region;
        if (c) setCity(c);
      }
    } catch {}
  }

  // ── Avvia ───────────────────────────────────────────────────
  async function handleStart() {
    try {
      await startGps('city');
      startAcc('city');
      route.current = []; setRouteSnap([]);
      prevLat.current = null; prevLon.current = null;
      const ns: State = {
        ...BLANK,
        isTracking: true, mode: 'city',
        sessionStartTs: Date.now(),
        totalDriveSecToday: st.totalDriveSecToday,
      };
      await saveState(ns); setSt(ns);
      await startFg();
      doCity();
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile avviare');
    }
  }

  // ── Ferma ───────────────────────────────────────────────────
  async function handleStop() {
    await stopGps(); stopAcc(); stopFg();
    const now = Date.now();
    if (st.tripStartTs !== null && st.tripDistM >= MIN_DIST_METERS) {
      const d = await loadDay();
      const km = Math.round((st.tripDistM / 1000) * 10) / 10;
      d.trips.push({
        startTs: st.tripStartTs, endTs: now,
        durSec: (now - st.tripStartTs) / 1000,
        distKm: km, maxKmh: Math.round(st.tripMaxKmh),
      });
      d.totalKm = Math.round((d.totalKm + km) * 10) / 10;
      d.totalDriveSec = st.totalDriveSecToday;
      await saveDay(d); setDay(d);
    }
    const ns: State = { ...BLANK, totalDriveSecToday: st.totalDriveSecToday };
    await saveState(ns); setSt(ns);
  }

  // ── Export ──────────────────────────────────────────────────
  async function doExport() {
    const d = await loadDay();
    if (!d.trips.length) { Alert.alert('Nessun dato', 'Nessun viaggio registrato oggi.'); return; }
    const lines = [
      `NEXUS FLOW — ${d.date}`,
      `────────────────────────────`,
      `Km totali:    ${d.totalKm} km`,
      `Tempo guida:  ${fmtDur(d.totalDriveSec)}`,
      `Viaggi:       ${d.trips.length}`,
      ``,
      `DETTAGLIO`,
      `────────────────────────────`,
    ];
    d.trips.forEach((t, i) => {
      lines.push(`Viaggio ${i + 1}`);
      lines.push(`  ${fmtTime(t.startTs)} → ${fmtTime(t.endTs)}  (${fmtDur(t.durSec)})`);
      lines.push(`  ${t.distKm} km  ·  max ${t.maxKmh} km/h`);
      lines.push('');
    });
    await Share.share({ message: lines.join('\n'), title: `Nexus Flow ${d.date}` });
  }

  // ── Calcoli live ────────────────────────────────────────────
  const now             = Date.now();
  const sessionSec      = st.sessionStartTs ? (now - st.sessionStartTs) / 1000 : 0;
  const contDriveSec    = st.contDriveStartTs ? (now - st.contDriveStartTs) / 1000 : 0;
  const toBreakSec      = Math.max(0, EU_MAX_DRIVE_SEC - contDriveSec);
  const euWarn          = contDriveSec >= EU_MAX_DRIVE_SEC - EU_WARN_SEC;
  const euLimit         = contDriveSec >= EU_MAX_DRIVE_SEC;
  const speedOver       = st.speedKmh > SPEED_LIMIT_KMH;
  const euPct           = Math.min(100, (contDriveSec / EU_MAX_DRIVE_SEC) * 100);
  const modeLabel       = { rest: 'RIPOSO', city: 'CITTÀ', travel: 'VIAGGIO' }[st.mode];
  const modeColor       = { rest: C.muted, city: C.blue, travel: C.green }[st.mode];
  const currentTripKm   = st.tripDistM / 1000;

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={s.center}>
          <Text style={[s.big, { color: C.green }]}>NEXUS FLOW</Text>
          <Text style={[s.small, { color: C.muted, marginTop: 8 }]}>Caricamento…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* HEADER */}
      <View style={s.header}>
        <View>
          <Text style={s.title}>NEXUS FLOW</Text>
          <Text style={s.titleSub}>GPS Tracker Professionale</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.clock}>{clock}</Text>
          <Text style={[s.small, { color: C.blue }]}>{city}</Text>
        </View>
      </View>

      {/* ALERT VELOCITÀ */}
      {speedOver && (
        <View style={[s.alertBar, { backgroundColor: C.red }]}>
          <Text style={s.alertTxt}>⚠  VELOCITÀ: {Math.round(st.speedKmh)} km/h — limite {SPEED_LIMIT_KMH} km/h</Text>
        </View>
      )}

      {/* ALERT EU */}
      {euLimit && (
        <View style={[s.alertBar, { backgroundColor: C.red }]}>
          <Text style={s.alertTxt}>🛑  PAUSA OBBLIGATORIA — Limite UE 4h 30m raggiunto</Text>
        </View>
      )}
      {!euLimit && euWarn && st.isTracking && (
        <View style={[s.alertBar, { backgroundColor: C.orange }]}>
          <Text style={s.alertTxt}>⏰  PAUSA TRA {fmtDur(toBreakSec)} — Norma UE tempi guida</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* MAPPA — placeholder fino a nuova build */}
        <View style={[s.mapBox, { alignItems: 'center', justifyContent: 'center' }]}>
          {st.lastLat !== null ? (
            <>
              <Text style={[s.small, { color: C.green, fontWeight: '700' }]}>📍 GPS ATTIVO</Text>
              <Text style={[s.small, { color: C.sub, marginTop: 4 }]}>
                {st.lastLat.toFixed(5)}, {st.lastLon?.toFixed(5)}
              </Text>
              <Text style={[s.small, { color: C.muted, marginTop: 6, textAlign: 'center', paddingHorizontal: 30 }]}>
                Mappa visiva disponibile dopo{'\n'}eas build --platform android --profile preview
              </Text>
            </>
          ) : (
            <Text style={[s.small, { color: C.muted }]}>
              {st.isTracking ? 'Acquisizione GPS…' : 'Avvia il tracking per la mappa'}
            </Text>
          )}
        </View>

        {/* MODALITÀ + VELOCITÀ */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={s.label}>MODALITÀ</Text>
              <Text style={[s.big, { color: modeColor }]}>{modeLabel}</Text>
              {st.isTracking && <Text style={s.small}>Sessione: {fmtDur(sessionSec)}</Text>}
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={[s.speedNum, { color: speedOver ? C.red : C.green }]}>
                {Math.round(st.speedKmh)}
              </Text>
              <Text style={[s.small, { color: C.sub }]}>km/h</Text>
            </View>
          </View>
        </View>

        {/* TEMPI GUIDA EU */}
        {st.isTracking && (
          <View style={s.card}>
            <Text style={s.label}>TEMPI DI GUIDA — NORMA UE</Text>
            <View style={s.row3}>
              <View style={s.col}>
                <Text style={s.val}>{fmtDur(contDriveSec)}</Text>
                <Text style={s.key}>Guida continua</Text>
              </View>
              <View style={s.col}>
                <Text style={[s.val, euLimit ? { color: C.red } : euWarn ? { color: C.orange } : {}]}>
                  {euLimit ? 'PAUSA!' : fmtDur(toBreakSec)}
                </Text>
                <Text style={s.key}>Alla pausa</Text>
              </View>
              <View style={s.col}>
                <Text style={s.val}>{fmtDur(st.totalDriveSecToday)}</Text>
                <Text style={s.key}>Totale oggi</Text>
              </View>
            </View>
            <View style={s.progressBg}>
              <View style={[s.progressFill, {
                width: `${euPct}%` as any,
                backgroundColor: euLimit ? C.red : euWarn ? C.orange : C.green,
              }]} />
            </View>
            <Text style={[s.small, { color: C.muted, marginTop: 4 }]}>
              {Math.round(euPct)}% del limite UE (4h 30m)
            </Text>
          </View>
        )}

        {/* VIAGGIO IN CORSO */}
        {st.tripStartTs !== null && (
          <View style={[s.card, { borderColor: C.green }]}>
            <Text style={[s.label, { color: C.green }]}>VIAGGIO IN CORSO</Text>
            <View style={s.row3}>
              <View style={s.col}>
                <Text style={s.val}>{currentTripKm.toFixed(1)} km</Text>
                <Text style={s.key}>Distanza</Text>
              </View>
              <View style={s.col}>
                <Text style={s.val}>{Math.round(st.tripMaxKmh)} km/h</Text>
                <Text style={s.key}>Max velocità</Text>
              </View>
              <View style={s.col}>
                <Text style={s.val}>{fmtDur((now - st.tripStartTs) / 1000)}</Text>
                <Text style={s.key}>Durata</Text>
              </View>
            </View>
            <Text style={[s.small, { marginTop: 4 }]}>Partenza: {fmtTime(st.tripStartTs)}</Text>
          </View>
        )}

        {/* RIEPILOGO GIORNATA */}
        <View style={s.card}>
          <Text style={s.label}>GIORNATA — {day.date}</Text>
          <View style={s.row3}>
            <View style={s.col}>
              <Text style={s.val}>{day.totalKm} km</Text>
              <Text style={s.key}>Percorsi</Text>
            </View>
            <View style={s.col}>
              <Text style={s.val}>{day.trips.length}</Text>
              <Text style={s.key}>Viaggi</Text>
            </View>
            <View style={s.col}>
              <Text style={s.val}>{fmtDur(day.totalDriveSec)}</Text>
              <Text style={s.key}>Tempo guida</Text>
            </View>
          </View>
        </View>

        {/* PULSANTE AVVIA / FERMA */}
        <TouchableOpacity
          style={[s.btnMain, { backgroundColor: st.isTracking ? C.redDark : C.greenDark }]}
          onPress={st.isTracking ? handleStop : handleStart}
          activeOpacity={0.8}
        >
          <Text style={s.btnMainTxt}>
            {st.isTracking ? '⏹  FERMA TRACKING' : '▶  AVVIA TRACKING'}
          </Text>
        </TouchableOpacity>

        {/* ESPORTA */}
        <TouchableOpacity style={s.btnExport} onPress={doExport} activeOpacity={0.8}>
          <Text style={s.btnExportTxt}>↑  ESPORTA GIORNATA</Text>
        </TouchableOpacity>

        {/* LISTA VIAGGI */}
        {day.trips.length > 0 && (
          <View style={s.card}>
            <Text style={s.label}>VIAGGI DI OGGI</Text>
            {[...day.trips].reverse().map((t, i) => (
              <View key={i} style={s.tripRow}>
                <View style={s.tripDot} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.tripTitle}>Viaggio — {t.distKm} km</Text>
                    <Text style={s.tripTime}>{fmtTime(t.startTs)} → {fmtTime(t.endTs)}</Text>
                  </View>
                  <Text style={s.tripSub}>Max {t.maxKmh} km/h · {fmtDur(t.durSec)}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================
// STILI
// ============================================================
const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 14, paddingTop: 10 },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  title:    { fontSize: 20, fontWeight: '800', color: C.green, letterSpacing: 2 },
  titleSub: { fontSize: 9,  fontWeight: '700', color: C.muted, letterSpacing: 1, marginTop: 1 },
  clock:    { fontSize: 18, fontWeight: '700', color: C.text },

  alertBar: { paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center' },
  alertTxt: { color: C.white, fontWeight: '700', fontSize: 12, textAlign: 'center' },

  mapBox: {
    height: 240, borderRadius: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border, marginBottom: 10, position: 'relative',
  },
  map: { flex: 1 },
  mapOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,14,26,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 10,
  },
  label: { fontSize: 9, color: C.muted, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },
  big:   { fontSize: 24, fontWeight: '800', color: C.text },
  small: { fontSize: 11, color: C.sub },

  speedNum: { fontSize: 56, fontWeight: '900', lineHeight: 60 },

  row3: { flexDirection: 'row', justifyContent: 'space-between' },
  col:  { flex: 1, alignItems: 'center' },
  val:  { fontSize: 17, fontWeight: '700', color: C.text },
  key:  { fontSize: 9, color: C.muted, marginTop: 3, textAlign: 'center' },

  progressBg:   { height: 6, backgroundColor: C.border, borderRadius: 3, marginTop: 10, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },

  btnMain: {
    borderRadius: 14, paddingVertical: 18,
    alignItems: 'center', marginBottom: 10, elevation: 4,
  },
  btnMainTxt:   { fontSize: 17, fontWeight: '800', color: C.white, letterSpacing: 1 },
  btnExport:    {
    backgroundColor: C.surfaceAlt, borderRadius: 14, paddingVertical: 13,
    alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: C.border,
  },
  btnExportTxt: { fontSize: 14, fontWeight: '700', color: C.blue },

  tripRow:   { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border, gap: 10 },
  tripDot:   { width: 10, height: 10, borderRadius: 5, backgroundColor: C.green, marginTop: 3 },
  tripTitle: { fontSize: 13, fontWeight: '700', color: C.text },
  tripTime:  { fontSize: 10, color: C.muted },
  tripSub:   { fontSize: 11, color: C.sub, marginTop: 2 },
});

registerRootComponent(App);
export default App;
