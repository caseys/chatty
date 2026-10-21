// three.js as the global THREE, for a downloaded 3D program (inlined only when it uses THREE)
import * as THREE from 'three';

(window as unknown as { THREE: unknown }).THREE = THREE;
