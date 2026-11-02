"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type ReadingLevelPoint = { level: string; english: number; filipino: number };

export function ReadingChart({ data }: { data: ReadingLevelPoint[] }) {
  if (!data.some((point) => point.english || point.filipino)) {
    return <div className="empty-chart">Reading assessment results will appear here once recorded.</div>;
  }

  return (
    <div className="chart-wrap" aria-label="Learners by reading level and language">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#e7ede8" vertical={false} />
          <XAxis dataKey="level" tick={{ fill: "#71807a", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: "#71807a", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="english" name="English" fill="#176b58" radius={[3, 3, 0, 0]} />
          <Bar dataKey="filipino" name="Filipino" fill="#d68a36" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}