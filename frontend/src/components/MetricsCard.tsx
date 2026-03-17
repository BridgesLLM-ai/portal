import { AreaChart, Area, ResponsiveContainer } from 'recharts';

interface MetricsCardProps {
  title: string;
  value: number;
  unit: string;
  color?: string;
  history: number[];
}

function getStatusColor(value: number): string {
  if (value < 50) return '#10B981'; // green
  if (value < 80) return '#F59E0B'; // yellow
  return '#EF4444'; // red
}

export default function MetricsCard({ title, value, unit, color, history }: MetricsCardProps) {
  const statusColor = color || getStatusColor(value);
  const chartData = history.map((v, i) => ({ i, v }));

  return (
    <div className="bg-[rgba(26,31,58,0.7)] backdrop-blur-xl border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400 font-medium">{title}</span>
        <div
          className="w-2.5 h-2.5 rounded-full animate-pulse"
          style={{ backgroundColor: statusColor }}
        />
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <span className="text-3xl font-bold text-[#F0F4F8]" style={{ color: statusColor }}>
            {typeof value === 'number' ? value.toFixed(1) : value}
          </span>
          <span className="text-sm text-gray-400 ml-1">{unit}</span>
        </div>

        {chartData.length > 1 && (
          <div className="w-24 h-10">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id={`grad-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={statusColor} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={statusColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke={statusColor}
                  strokeWidth={1.5}
                  fill={`url(#grad-${title})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
