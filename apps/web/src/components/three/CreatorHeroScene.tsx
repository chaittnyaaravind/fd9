import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const LIME = new THREE.Color("#b9e82f");
const VIOLET = new THREE.Color("#9b8cff");
const ICE = new THREE.Color("#7dd3fc");

/**
 * Procedural PMREM reflections (three's own RoomEnvironment addon) instead
 * of an HDRI texture download — "looks made" via real reflections without
 * adding a network asset, matching the rest of this app's zero-heavy-asset
 * 3D budget (see HeroScene.tsx's own restraint).
 */
function useRoomEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    return () => {
      envTexture.dispose();
      pmrem.dispose();
      scene.environment = null;
    };
  }, [gl, scene]);
}

interface FieldProps {
  particleCount: number;
}

/** Fine particles suggesting ideas condensing into the structure at the center. */
function IdeaField({ particleCount }: FieldProps) {
  const pointsRef = useRef<THREE.Points>(null);

  const { positions, colors } = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const radius = 1.8 + Math.random() * 2.6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi) * 0.7;
      const roll = Math.random();
      const c = roll > 0.82 ? VIOLET : roll > 0.64 ? ICE : LIME;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    return { positions, colors };
  }, [particleCount]);

  useFrame((_, delta) => {
    if (pointsRef.current) pointsRef.current.rotation.y -= delta * 0.02;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.028}
        vertexColors
        transparent
        opacity={0.75}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

interface ObjectProps {
  parallax: boolean;
  mouseRef: React.RefObject<{ x: number; y: number }>;
}

/** The sculptural "object" itself: a solid metallic core with a slightly larger wireframe shell — structure becoming visible around a built thing. */
function BuiltForm({ parallax, mouseRef }: ObjectProps) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    group.rotation.y += delta * 0.09;
    if (parallax && mouseRef.current) {
      const targetX = mouseRef.current.y * 0.09;
      const targetZ = -mouseRef.current.x * 0.09;
      group.rotation.x += (targetX - group.rotation.x) * 0.05;
      group.rotation.z += (targetZ - group.rotation.z) * 0.05;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh>
        <icosahedronGeometry args={[1.3, 1]} />
        <meshPhysicalMaterial
          color="#1d1a16"
          metalness={0.88}
          roughness={0.28}
          clearcoat={0.5}
          clearcoatRoughness={0.25}
          envMapIntensity={1.4}
        />
      </mesh>
      <mesh scale={1.22}>
        <icosahedronGeometry args={[1.3, 1]} />
        <meshBasicMaterial color={LIME} wireframe transparent opacity={0.18} />
      </mesh>
    </group>
  );
}

interface Props {
  particleCount: number;
  parallax: boolean;
  paused: boolean;
  mouseRef: React.RefObject<{ x: number; y: number }>;
}

function Scene({ particleCount, parallax, mouseRef }: Omit<Props, "paused">) {
  useRoomEnvironment();
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[3, 4, 5]} intensity={1.1} color={LIME} />
      <pointLight position={[-4, -1, -3]} intensity={6} color={VIOLET} />
      <pointLight position={[2, -3, 2]} intensity={3} color={ICE} />
      <BuiltForm parallax={parallax} mouseRef={mouseRef} />
      <IdeaField particleCount={particleCount} />
    </>
  );
}

/**
 * Lives in its own chunk (dynamically imported by CreatorHeroCanvas), same
 * reasoning as the home hero's HeroScene: three.js/@react-three/fiber never
 * land in the main bundle for a user who gets the reduced-motion/no-WebGL
 * fallback instead.
 */
export default function CreatorHeroScene({ particleCount, parallax, paused, mouseRef }: Props) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0, 6.5], fov: 42 }}
      frameloop={paused ? "never" : "always"}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.1;
      }}
    >
      <Scene particleCount={particleCount} parallax={parallax} mouseRef={mouseRef} />
    </Canvas>
  );
}
