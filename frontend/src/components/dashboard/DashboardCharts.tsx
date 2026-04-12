import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Cpu, Wifi } from 'lucide-react';

interface ChartPoint {
  time: string;
  cpu: number;
  memory: number;
  netIn: number;
  netOut: number;
}

export default function DashboardCharts({ chartData }: { chartData: ChartPoint[] }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="glass hover-glow p-5">
        <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
          <Cpu size={14} className="text-emerald-400" />
          CPU & Memory (6h)
        </h3>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} width={35} />
            <Tooltip
              contentStyle={{
                background: 'rgba(26,31,58,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                color: '#F0F4F8',
                backdropFilter: 'blur(12px)',
              }}
            />
            <Area type="monotone" dataKey="cpu" stroke="#10B981" fill="url(#cpuGrad)" strokeWidth={2} name="CPU %" />
            <Area type="monotone" dataKey="memory" stroke="#3B82F6" fill="url(#memGrad)" strokeWidth={2} name="Memory %" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="glass hover-glow p-5">
        <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
          <Wifi size={14} className="text-cyan-400" />
          Network I/O (6h)
        </h3>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="netInGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06B6D4" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#06B6D4" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="netOutGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#F59E0B" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
            <Tooltip
              contentStyle={{
                background: 'rgba(26,31,58,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                color: '#F0F4F8',
                backdropFilter: 'blur(12px)',
              }}
              formatter={(v: number) => `${v.toFixed(2)} MB/s`}
            />
            <Area type="monotone" dataKey="netIn" stroke="#06B6D4" fill="url(#netInGrad)" strokeWidth={2} name="In" />
            <Area type="monotone" dataKey="netOut" stroke="#F59E0B" fill="url(#netOutGrad)" strokeWidth={2} name="Out" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
