import { CommonModule } from '@angular/common';
import { Component, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment';

declare global { interface Window { longdo: any; } }

type Point = { lat: number; lon: number; time?: number; accuracy?: number };

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnDestroy {
  readonly apiKey = environment.longdoMapApiKey;
  roomId = localStorage.getItem('gps-room') ?? '';
  role: 'driver' | 'passenger' = (localStorage.getItem('gps-role') as 'driver' | 'passenger') ?? 'driver';
  keyReady = signal(false);
  mapReady = signal(false);
  tracking = signal(false);
  gpsStatus = signal('ยังไม่ได้เริ่มจับตำแหน่ง');
  pickup = signal<Point | null>(null);
  destination = signal<Point | null>(null);
  selfLocation = signal<Point | null>(null);
  markMode = signal<'pickup' | 'dropoff' | null>(null);
  driverSharing = signal(false);
  roadDistance = signal('—');
  routeCalculating = signal(false);
  clearingRoute = signal(false);
  current = signal<Point | null>(null);
  points = signal<Point[]>([]);
  distanceKm = signal(0);
  durationText = signal('00:00:00');
  savedTrips = signal<any[]>(JSON.parse(localStorage.getItem('gps-trips') ?? '[]'));

  private map: any;
  private userMarker: any;
  private selfMarker: any;
  private pickupMarker: any;
  private destinationMarker: any;
  private trackLine: any;
  private guideLine: any;
  private watchId?: number;
  private startedAt?: number;
  private clock?: number;
  private readonly supabase: SupabaseClient = createClient(environment.supabaseUrl, environment.supabasePublishableKey);
  private roomChannel?: RealtimeChannel;

  loadMap() {
    if (!this.roomId.trim()) {
      this.gpsStatus.set('กรุณาใส่เลข ID ห้อง');
      return;
    }
    localStorage.setItem('gps-room', this.roomId.trim());
    localStorage.setItem('gps-role', this.role);
    const existing = document.querySelector('#longdo-script');
    if (existing) { this.initMap(); return; }
    const script = document.createElement('script');
    script.id = 'longdo-script';
    script.src = `https://api.longdo.com/map/?key=${encodeURIComponent(this.apiKey.trim())}`;
    script.onload = () => this.initMap();
    script.onerror = () => this.gpsStatus.set('โหลดแผนที่ไม่สำเร็จ กรุณาตรวจ API Key');
    document.head.appendChild(script);
  }

  private initMap() {
    if (!window.longdo || this.map) return;
    this.keyReady.set(true);
    setTimeout(() => {
      this.map = new window.longdo.Map({
        placeholder: document.getElementById('map'),
        zoom: 15,
        location: { lon: 100.5018, lat: 13.7563 }
      });
      this.map.Event.bind('ready', () => {
        this.mapReady.set(true);
        this.map.Event.bind('guideComplete', () => {
          this.roadDistance.set(String(this.map.Route.distance(true)));
          this.routeCalculating.set(false);
        });
        this.connectRoom();
        if (this.role === 'passenger') setTimeout(() => this.locateMe());
      });
      this.map.Event.bind('click', () => this.handleMapClick());
    });
  }

  locateMe() {
    navigator.geolocation.getCurrentPosition(
      p => {
        const point = this.fromPosition(p);
        this.selfLocation.set(point);
        if (this.role === 'driver') this.current.set(point);
        this.renderSelf(point);
        this.map.location(point, true);
        this.gpsStatus.set(`พบตำแหน่งแล้ว ±${Math.round(p.coords.accuracy)} ม.`);
      },
      e => this.gpsStatus.set(this.geoError(e)),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  setDestination(point: Point, broadcast = true) {
    if (!point?.lat || !point?.lon) return;
    this.destination.set({ lat: point.lat, lon: point.lon });
    if (this.destinationMarker) this.map.Overlays.remove(this.destinationMarker);
    this.destinationMarker = new window.longdo.Marker(point, {
      title: 'จุดหมาย',
      detail: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
      icon: { html: '<div class="destination-pin"><span>ส่ง</span></div>', offset: { x: 18, y: 42 } }
    });
    this.map.Overlays.add(this.destinationMarker);
    this.renderGuide();
    if (broadcast) this.sendRoomEvent({ type: 'dropoff', point: this.destination() });
  }

  chooseMark(mode: 'pickup' | 'dropoff') {
    if (this.role !== 'driver' || this.tracking()) return;
    this.markMode.set(mode);
    this.gpsStatus.set(mode === 'pickup' ? 'แตะตำแหน่งจุดรับบนแผนที่' : 'แตะตำแหน่งจุดส่งบนแผนที่');
  }

  private handleMapClick() {
    if (this.role !== 'driver' || !this.markMode()) return;
    const point = this.map.location(window.longdo.LocationMode.Pointer) as Point;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
    if (this.markMode() === 'pickup') this.setPickup(point);
    else this.setDestination(point);
    this.markMode.set(null);
  }

  private setPickup(point: Point, broadcast = true) {
    this.pickup.set({ lat: point.lat, lon: point.lon });
    if (this.pickupMarker) this.map.Overlays.remove(this.pickupMarker);
    this.pickupMarker = new window.longdo.Marker(point, {
      title: 'จุดรับผู้โดยสาร', detail: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
      icon: { html: '<div class="pickup-pin"><span>รับ</span></div>', offset: { x: 19, y: 42 } }
    });
    this.map.Overlays.add(this.pickupMarker);
    this.renderGuide();
    if (broadcast) this.sendRoomEvent({ type: 'pickup', point: this.pickup() });
  }

  startTracking() {
    if (this.role !== 'driver') return;
    if (!this.pickup() || !this.destination()) {
      this.gpsStatus.set('กรุณาปักทั้งจุดรับและจุดส่งก่อนเริ่มแชร์');
      return;
    }
    if (!navigator.geolocation) { this.gpsStatus.set('อุปกรณ์นี้ไม่รองรับ GPS'); return; }
    this.points.set([]);
    this.distanceKm.set(0);
    this.startedAt = Date.now();
    this.tracking.set(true);
    this.driverSharing.set(true);
    this.sendRoomEvent({ type: 'share-status', active: true });
    this.clock = window.setInterval(() => this.updateClock(), 1000);
    this.watchId = navigator.geolocation.watchPosition(
      p => this.record(this.fromPosition(p)),
      e => { this.gpsStatus.set(this.geoError(e)); if (e.code === 1) this.stopTracking(false); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  stopTracking(save = true) {
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
    if (this.clock) clearInterval(this.clock);
    this.watchId = undefined;
    this.tracking.set(false);
    if (this.role === 'driver' && this.driverSharing()) {
      this.driverSharing.set(false);
      this.sendRoomEvent({ type: 'share-status', active: false });
    }
    if (save && this.points().length > 1) {
      const trip = {
        id: Date.now(), date: new Date().toISOString(), duration: this.durationText(),
        distance: this.distanceKm(), destination: this.destination(), points: this.points()
      };
      const trips = [trip, ...this.savedTrips()].slice(0, 10);
      this.savedTrips.set(trips);
      localStorage.setItem('gps-trips', JSON.stringify(trips));
      this.gpsStatus.set('บันทึกการเดินทางเรียบร้อย');
    }
  }

  async clearTrip() {
    if (this.role !== 'driver' || this.clearingRoute()) return;
    this.clearingRoute.set(true);
    if (this.tracking()) this.stopTracking(false);
    this.points.set([]); this.distanceKm.set(0); this.durationText.set('00:00:00');
    if (this.trackLine) this.map.Overlays.remove(this.trackLine);
    this.trackLine = undefined;
    this.clearRoutePoints();
    const { error } = await this.supabase
      .from('trip_rooms')
      .update({
        pickup_lat: null, pickup_lon: null,
        dropoff_lat: null, dropoff_lon: null,
        driver_lat: null, driver_lon: null,
        sharing: false,
        updated_at: new Date().toISOString()
      })
      .eq('room_id', this.roomId.trim().toUpperCase());
    this.clearingRoute.set(false);
    if (error) {
      this.gpsStatus.set(`ล้างหมุดไม่สำเร็จ: ${error.message}`);
      return;
    }
    this.driverSharing.set(false);
    this.gpsStatus.set('ล้างจุดรับ จุดส่ง และเส้นทางแล้ว');
  }

  private clearRoutePoints() {
    if (this.pickupMarker) this.map.Overlays.remove(this.pickupMarker);
    if (this.destinationMarker) this.map.Overlays.remove(this.destinationMarker);
    this.pickupMarker = undefined;
    this.destinationMarker = undefined;
    this.pickup.set(null);
    this.destination.set(null);
    this.markMode.set(null);
    this.roadDistance.set('—');
    this.routeCalculating.set(false);
    if (this.map?.Route) this.map.Route.clear();
  }

  deleteSaved(id: number) {
    const trips = this.savedTrips().filter(t => t.id !== id);
    this.savedTrips.set(trips); localStorage.setItem('gps-trips', JSON.stringify(trips));
  }

  viewTrip(trip: any) {
    if (!this.map || !trip.points?.length) return;
    this.points.set(trip.points); this.distanceKm.set(trip.distance);
    this.renderTrack(); this.map.location(trip.points[0], true);
  }

  remainingKm() {
    return this.current() && this.destination() ? this.haversine(this.current()!, this.destination()!) : 0;
  }

  markedDistanceKm() {
    return this.pickup() && this.destination() ? this.haversine(this.pickup()!, this.destination()!) : 0;
  }

  private async connectRoom() {
    if (this.roomChannel) await this.supabase.removeChannel(this.roomChannel);
    const room = this.roomId.trim().toUpperCase();

    const { data, error } = await this.supabase.from('trip_rooms').select('*').eq('room_id', room).maybeSingle();
    if (error) {
      this.gpsStatus.set(`เชื่อมต่อห้องไม่สำเร็จ: ${error.message}`);
      return;
    }
    if (data) this.applyRoomState(data);

    this.roomChannel = this.supabase
      .channel(`trip-room-${room}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_rooms', filter: `room_id=eq.${room}` }, payload => {
        if (payload.new && Object.keys(payload.new).length) this.applyRoomState(payload.new);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          this.gpsStatus.set(this.role === 'driver' ? 'เชื่อมต่อห้องแล้ว พร้อมแชร์ตำแหน่ง' : this.driverSharing() ? 'คนขับกำลังแชร์ตำแหน่ง' : 'เข้าห้องแล้ว กำลังรอคนขับ');
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.gpsStatus.set('Realtime ขาดการเชื่อมต่อ ระบบกำลังลองใหม่');
      });
  }

  private applyRoomState(row: any) {
    if (this.clearingRoute()) return;
    const sharing = !!row.sharing;
    this.driverSharing.set(sharing);
    const pickup = Number.isFinite(row.pickup_lat) && Number.isFinite(row.pickup_lon) ? { lat: row.pickup_lat, lon: row.pickup_lon } : null;
    const dropoff = Number.isFinite(row.dropoff_lat) && Number.isFinite(row.dropoff_lon) ? { lat: row.dropoff_lat, lon: row.dropoff_lon } : null;

    if (pickup && (!this.pickup() || this.haversine(this.pickup()!, pickup) > 0.001)) this.setPickup(pickup, false);
    if (dropoff && (!this.destination() || this.haversine(this.destination()!, dropoff) > 0.001)) this.setDestination(dropoff, false);
    if (!pickup && this.pickup()) {
      if (this.pickupMarker) this.map.Overlays.remove(this.pickupMarker);
      this.pickupMarker = undefined;
      this.pickup.set(null);
      this.renderGuide();
    }
    if (!dropoff && this.destination()) {
      if (this.destinationMarker) this.map.Overlays.remove(this.destinationMarker);
      this.destinationMarker = undefined;
      this.destination.set(null);
      this.renderGuide();
    }
    if (!pickup && !dropoff && this.role === 'passenger') {
      this.points.set([]); this.distanceKm.set(0);
      if (this.trackLine) this.map.Overlays.remove(this.trackLine);
      this.trackLine = undefined;
    }

    if (this.role === 'passenger') {
      if (sharing && Number.isFinite(row.driver_lat) && Number.isFinite(row.driver_lon)) {
        this.recordRemote({ lat: row.driver_lat, lon: row.driver_lon, time: Date.parse(row.updated_at) });
      } else {
        this.gpsStatus.set('กำลังรอคนขับกดแชร์ตำแหน่ง');
        if (this.userMarker) this.map.Overlays.remove(this.userMarker);
        this.userMarker = undefined;
        this.current.set(null);
      }
    }
  }

  private recordRemote(point: Point) {
    const old = this.points();
    const next = old.length && this.haversine(old[old.length - 1], point) < 0.003 ? old : [...old, point];
    this.points.set(next.slice(-500));
    this.current.set(point);
    this.distanceKm.set(this.pathDistance(this.points()));
    this.gpsStatus.set(`เห็นตำแหน่งคนขับแล้ว • แม่นยำ ±${Math.round(point.accuracy ?? 0)} ม.`);
    this.renderDriver(point); this.renderTrack(); this.renderGuide();
    if (this.map) this.map.location(point, true);
  }

  private async sendRoomEvent(payload: any) {
    const row: any = { room_id: this.roomId.trim().toUpperCase(), updated_at: new Date().toISOString() };
    if (payload.type === 'pickup') Object.assign(row, { pickup_lat: payload.point.lat, pickup_lon: payload.point.lon });
    if (payload.type === 'dropoff') Object.assign(row, { dropoff_lat: payload.point.lat, dropoff_lon: payload.point.lon });
    if (payload.type === 'location') Object.assign(row, { driver_lat: payload.point.lat, driver_lon: payload.point.lon });
    if (payload.type === 'share-status') row.sharing = payload.active;
    const { error } = await this.supabase.from('trip_rooms').upsert(row, { onConflict: 'room_id' });
    if (error) this.gpsStatus.set(`ส่งข้อมูลเข้าห้องไม่สำเร็จ: ${error.message}`);
  }

  private record(point: Point) {
    const old = this.points();
    if (old.length && this.haversine(old[old.length - 1], point) < 0.003) return;
    this.points.set([...old, point]);
    this.current.set(point);
    this.distanceKm.set(this.pathDistance(this.points()));
    this.gpsStatus.set(`กำลังบันทึก • แม่นยำ ±${Math.round(point.accuracy ?? 0)} ม.`);
    this.selfLocation.set(point);
    this.renderSelf(point); this.renderTrack(); this.renderGuide();
    this.map.location(point, true);
    this.sendRoomEvent({ type: 'location', point });
  }

  private renderDriver(point: Point) {
    if (!this.map) return;
    if (!this.userMarker) {
      this.userMarker = new window.longdo.Marker(point, {
        title: 'ตำแหน่งคนขับ',
        icon: { html: '<div class="driver-car"><span>🚘</span><i></i></div>', offset: { x: 24, y: 24 } }
      });
      this.map.Overlays.add(this.userMarker);
    } else this.userMarker.move(point, true);
  }

  private renderSelf(point: Point) {
    if (!this.map) return;
    if (!this.selfMarker) {
      this.selfMarker = new window.longdo.Marker(point, {
        title: 'ตำแหน่งของฉัน',
        icon: { html: '<div class="self-marker"><span>ฉัน</span><i></i></div>', offset: { x: 24, y: 24 } }
      });
      this.map.Overlays.add(this.selfMarker);
    } else this.selfMarker.move(point, true);
  }

  private renderTrack() {
    if (this.trackLine) this.map.Overlays.remove(this.trackLine);
    if (this.points().length > 1) {
      this.trackLine = new window.longdo.Polyline(this.points(), { lineColor: '#176b55', lineWidth: 6 });
      this.map.Overlays.add(this.trackLine);
    }
  }

  private renderGuide() {
    if (!this.map?.Route) return;
    this.map.Route.clear();
    this.roadDistance.set('—');
    if (!this.pickup() || !this.destination()) return;
    this.routeCalculating.set(true);
    this.map.Route.useStopMarker(false);
    this.map.Route.mode(window.longdo.RouteMode.Traffic);
    this.map.Route.label(window.longdo.RouteLabel.Distance);
    this.map.Route.add(this.pickup());
    this.map.Route.add(this.destination());
    this.map.Route.search();
  }

  private fromPosition(p: GeolocationPosition): Point { return { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, time: p.timestamp }; }
  private updateClock() { const s = Math.floor((Date.now() - (this.startedAt ?? Date.now())) / 1000); this.durationText.set([Math.floor(s/3600), Math.floor(s/60)%60, s%60].map(v => String(v).padStart(2,'0')).join(':')); }
  private pathDistance(points: Point[]) { return points.slice(1).reduce((n, p, i) => n + this.haversine(points[i], p), 0); }
  private haversine(a: Point, b: Point) { const r=6371, dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lon-a.lon)*Math.PI/180; const q=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2; return 2*r*Math.asin(Math.sqrt(q)); }
  private geoError(e: GeolocationPositionError) { return e.code === 1 ? 'กรุณาอนุญาตให้เว็บไซต์เข้าถึงตำแหน่ง' : e.code === 2 ? 'ไม่พบสัญญาณ GPS' : 'ใช้เวลาหาตำแหน่งนานเกินไป ลองอีกครั้ง'; }
  ngOnDestroy() { if (this.tracking()) this.stopTracking(false); if (this.roomChannel) this.supabase.removeChannel(this.roomChannel); }
}
