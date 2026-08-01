import { motion } from 'framer-motion';
import { usePublicSettings } from '../hooks/usePublicSettings';

export default function PublicAuthBrand() {
  const settings = usePublicSettings();
  const portalName = settings?.portalName?.trim() || 'BridgesLLM';
  const logoUrl = settings?.logoUrl?.trim() || '';

  return (
    <>
      <motion.div
        whileHover={{ scale: 1.05 }}
        className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
          border: '1px solid rgba(16,185,129,0.2)',
          boxShadow: '0 0 30px rgba(16,185,129,0.15), inset 0 1px 0 rgba(16,185,129,0.1)',
        }}
      >
        {logoUrl ? (
          <img src={logoUrl} alt={`${portalName} logo`} className="h-full w-full object-contain p-2" />
        ) : (
          <span aria-hidden="true" className="text-emerald-400 font-bold text-2xl">
            {portalName.charAt(0).toUpperCase() || 'B'}
          </span>
        )}
      </motion.div>
      <h1 className="text-2xl font-bold text-white tracking-tight break-words">{portalName}</h1>
    </>
  );
}
