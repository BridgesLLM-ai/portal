/**
 * Document Card Component - Phase 4.1
 * 
 * Enhanced display for PDF reports with:
 * - Sentiment color-coded badges
 * - Key takeaways prominently displayed
 * - Better text preview layout
 */

import { motion } from 'framer-motion';
import { FileText, Calendar, TrendingUp, TrendingDown, Minus, Trash2, RefreshCw } from 'lucide-react';

interface DocumentCardProps {
  report: {
    id: string;
    filename: string;
    reportDate: string;
    source: string | null;
    uploadedAt: string;
    extracted: boolean;
    extractedAt: string | null;
    sentiment: number | null;
    active: boolean;
    extractedData: any;
    ageInDays: number;
  };
  onDelete: (id: string) => void;
  onReExtract: (id: string) => void;
}

export default function DocumentCard({ report, onDelete, onReExtract }: DocumentCardProps) {
  // Get sentiment badge
  const getSentimentBadge = () => {
    if (!report.extracted || report.sentiment === null) {
      return (
        <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-gray-900/50 text-gray-400 border border-gray-700">
          <Minus className="w-3 h-3" />
          Pending
        </span>
      );
    }

    const sentimentScore = report.sentiment * 100;
    
    if (sentimentScore > 10) {
      return (
        <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-green-900/30 text-green-400 border border-green-700">
          <TrendingUp className="w-3 h-3" />
          Positive
        </span>
      );
    } else if (sentimentScore < -10) {
      return (
        <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-red-900/30 text-red-400 border border-red-700">
          <TrendingDown className="w-3 h-3" />
          Negative
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-gray-900/30 text-gray-400 border border-gray-700">
          <Minus className="w-3 h-3" />
          Neutral
        </span>
      );
    }
  };

  // Get status badge
  const getStatusBadge = () => {
    if (!report.extracted) {
      return (
        <span className="px-2 py-1 text-xs rounded-full bg-yellow-900/20 text-yellow-400 border border-yellow-700/30">
          Processing
        </span>
      );
    }
    if (!report.active) {
      return (
        <span className="px-2 py-1 text-xs rounded-full bg-gray-900/20 text-gray-500 border border-gray-700/30">
          Expired
        </span>
      );
    }
    return (
      <span className="px-2 py-1 text-xs rounded-full bg-emerald-900/20 text-emerald-400 border border-emerald-700/30">
        Active
      </span>
    );
  };

  // Extract key takeaways from extractedData
  const getKeyTakeaways = () => {
    if (!report.extractedData) return [];
    
    // Parse JSON if string
    let data = report.extractedData;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return [];
      }
    }

    // Extract takeaways (could be in various formats)
    if (data.keyTakeaways) {
      if (Array.isArray(data.keyTakeaways)) {
        return data.keyTakeaways;
      }
      if (typeof data.keyTakeaways === 'string') {
        return data.keyTakeaways.split('\n').filter(Boolean).slice(0, 3);
      }
    }

    // Fallback: try to extract from summary or other fields
    if (data.summary) {
      return [data.summary.substring(0, 150) + '...'];
    }

    return [];
  };

  const keyTakeaways = getKeyTakeaways();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="bg-[#1a1f3a] border border-gray-700/50 rounded-lg p-5 hover:border-emerald-500/30 transition-all duration-200"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3 flex-1">
          <div className="p-2 bg-emerald-900/20 rounded-lg">
            <FileText className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-gray-200 mb-1">
              {report.source || 'Unknown Source'}
            </h4>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Calendar className="w-3 h-3" />
              <span>{new Date(report.reportDate).toLocaleDateString()}</span>
              <span>•</span>
              <span>{report.ageInDays}d old</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {report.extracted && (
            <button
              onClick={() => onReExtract(report.id)}
              className="p-1.5 text-blue-400 hover:text-blue-300 hover:bg-blue-900/20 rounded transition-colors"
              title="Re-extract"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onDelete(report.id)}
            className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Status Badges */}
      <div className="flex items-center gap-2 mb-4">
        {getSentimentBadge()}
        {getStatusBadge()}
      </div>

      {/* Key Takeaways */}
      {keyTakeaways.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-700/50">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Key Takeaways
          </p>
          <ul className="space-y-2">
            {keyTakeaways.map((takeaway: string, idx: number) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-emerald-400 mt-1">•</span>
                <span className="text-sm text-gray-300 leading-relaxed flex-1">
                  {takeaway}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filename (footer) */}
      <div className="mt-4 pt-3 border-t border-gray-700/30">
        <p className="text-xs text-gray-500 truncate" title={report.filename}>
          {report.filename}
        </p>
      </div>
    </motion.div>
  );
}
