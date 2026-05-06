// Importamos Firebase Auth además de Firestore
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAm322qqCH2Di-R3_iFBuJaam3Gu0hUbJw",
  authDomain: "sonya-6367a.firebaseapp.com",
  projectId: "sonya-6367a",
  storageBucket: "sonya-6367a.firebasestorage.app",
  messagingSenderId: "780942251144",
  appId: "1:780942251144:web:354bfa673610c89e9d3b3d",
  measurementId: "G-1MMJZ5S3F3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Inicializamos la Autenticación y el proveedor de Google
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export { db, auth, provider };