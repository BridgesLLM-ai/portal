import { MotionConfig } from 'framer-motion';
import Layout from './Layout';
import GlobalControls from './GlobalControls';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Keep the state-heavy authenticated shell out of the bootstrap/login bundle.
 * Agent Chat owns its stream provider at the route boundary so Dashboard,
 * Mail, Files, Settings, and Projects do not keep chat sockets, watchdogs,
 * transcript state, and high-frequency timers alive in the background.
 */
export default function PortalLayoutShell() {
  const { resolvedEffects } = useTheme();
  return (
    <MotionConfig reducedMotion={resolvedEffects === 'reduced' ? 'always' : 'user'}>
      <GlobalControls>
        <Layout />
      </GlobalControls>
    </MotionConfig>
  );
}
