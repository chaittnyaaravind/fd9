import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

const ACCENT = new THREE.Color("#4c8cff");
const SAND = new THREE.Color("#d9b88a");

interface FieldProps {
  particleCount: number;
  parallax: boolean;
  mouseRef: React.RefObject<{ x: number; y: number }>;
}

function NetworkField({ particleCount, parallax, mouseRef }: FieldProps) {
  const groupRef = useRef<THREE.Group>(null);

  const { positions, colors } = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const radius = 3.1 + Math.random() * 2.3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.55;
      positions[i * 3 + 2] = radius * Math.cos(phi) * 0.55 - 1.2;
      const c = Math.random() > 0.8 ? SAND : ACCENT;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    return { positions, colors };
  }, [particleCount]);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    group.rotation.y += delta * 0.035;
    if (parallax && mouseRef.current) {
      const targetX = mouseRef.current.y * 0.12;
      const targetZ = mouseRef.current.x * 0.12;
      group.rotation.x += (targetX - group.rotation.x) * 0.04;
      group.rotation.z += (targetZ - group.rotation.z) * 0.04;
    }
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.045}
          vertexColors
          transparent
          opacity={0.85}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

interface Props {
  particleCount: number;
  parallax: boolean;
  paused: boolean;
  mouseRef: React.RefObject<{ x: number; y: number }>;
}

/**
 * The actual WebGL content — lives in its own chunk (dynamically imported by
 * HeroCanvas) so three.js / @react-three/fiber never land in the main bundle
 * for users who never render it (e.g. prefers-reduced-motion).
 */
export default function HeroScene({ particleCount, parallax, paused, mouseRef }: Props) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0, 6], fov: 45 }}
      frameloop={paused ? "never" : "always"}
    >
      <NetworkField particleCount={particleCount} parallax={parallax} mouseRef={mouseRef} />
    </Canvas>
  );
}
