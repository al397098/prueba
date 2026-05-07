import { db, auth } from './firebase-config.js';
import { collection, getDocs, addDoc, deleteDoc, doc, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

class SonyaConnector {
    constructor() {
        this.uid = null; // Guardará el ID único del usuario logueado
    }

    // ─── Singleton & Auth Gatekeeper ─────────────────────────
    static async init() {
        if (window.__sonyaConnector) return window.__sonyaConnector;
        const instance = new SonyaConnector();

        return new Promise((resolve) => {
            onAuthStateChanged(auth, (user) => {
                if (user) {
                    // Usuario logueado: le damos acceso y guardamos su ID
                    instance.uid = user.uid;
                    window.__sonyaConnector = instance;
                    resolve(instance);
                } else {
                    // Si no hay usuario y estamos dentro de la app (public/), lo echamos al login
                    if (window.location.pathname.includes('/public/')) {
                        window.location.href = '../index.html';
                    } else {
                        resolve(instance); // Estamos en el index, dejamos que se cargue la UI de Login
                    }
                }
            });
        });
    }

    // ─── Rutas Dinámicas (Privadas por usuario) ──────────────
    // Ahora todo se guarda dentro de: usuarios -> [UID] -> acciones/alternativas
    getAccionesRef() { return collection(db, "usuarios", this.uid, "acciones"); }
    getAlternativasRef() { return collection(db, "usuarios", this.uid, "alternativas"); }
    getAltDoc(altId) { return doc(db, "usuarios", this.uid, "alternativas", altId); }

    // ─── API Pública Asíncrona ───────────────────────────────
    async getUFs() {
        try {
            const ufs = [];
            const querySnapshot = await getDocs(this.getAccionesRef());
            querySnapshot.forEach((doc) => {
                ufs.push({ id: doc.id, label: doc.data().label || doc.id, unit: doc.data().unit || 'Unidades', count: doc.data().count || 0 });
            });
            return ufs;
        } catch (error) { console.error(error); return []; }
    }

    async addUF(ufData) {
        try {
            const docRef = await addDoc(this.getAccionesRef(), { label: ufData.label, unit: ufData.unit || 'Unidades', count: 0 });
            return { id: docRef.id, ...ufData };
        } catch (error) { console.error(error); throw error; }
    }
    async removeUF(ufId) {
        try {
            // 1. Borramos la Acción principal
            await deleteDoc(doc(db, "usuarios", this.uid, "acciones", ufId));
            
            // 2. Borrado en cascada: buscamos y borramos las alternativas que colgaran de ella
            const alts = await this.getAlternatives(ufId);
            for (const alt of alts) {
                await this.removeAlternative(alt.id);
            }
            return true;
        } catch (error) { 
            console.error("Error eliminando Acción:", error); 
            throw error; 
        }
    }

    async getAlternatives(ufId) {
        try {
            const alts = [];
            const q = query(this.getAlternativasRef(), where("ufId", "==", ufId));
            const querySnapshot = await getDocs(q);
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                alts.push({
                    id: doc.id, ufId: data.ufId, nombre: data.nombre, tipo: data.tipo || 'EX-POST',
                    eco: parseFloat(data.eco) || 0, amb: parseFloat(data.amb) || 0, soc: parseFloat(data.soc) || 0,
                    satisfaccion: parseFloat(data.satisfaccion) || 50, source: 'cloud'
                });
            });
            return alts;
        } catch (error) { console.error(error); return []; }
    }

    async addAlternative(ufId, altData) {
        try {
            const flatAlt = {
                ufId: ufId, nombre: altData.nombre || altData.label || 'Nueva Alternativa', tipo: altData.tipo || 'EX-POST',
                eco: parseFloat(altData.eco || altData.scores?.eco) || 0, amb: parseFloat(altData.amb || altData.scores?.amb) || 0,
                soc: parseFloat(altData.soc || altData.scores?.soc) || 0, satisfaccion: parseFloat(altData.satisfaccion) || 50
            };
            const docRef = await addDoc(this.getAlternativasRef(), flatAlt);
            return { id: docRef.id, ...flatAlt, source: 'cloud' };
        } catch (error) { console.error(error); throw error; }
    }

    async removeAlternative(altId) {
        try {
            await deleteDoc(this.getAltDoc(altId));
            return true;
        } catch (error) { console.error(error); throw error; }
    }
}
window.SonyaConnector = SonyaConnector;