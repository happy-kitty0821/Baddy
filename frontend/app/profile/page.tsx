"use client";

import { useEffect, useState } from "react";
import apiClient from "@/lib/api";
import type { SystemInfo, SystemGpu } from "@/types/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        ok
          ? "bg-green-900/50 text-green-400 border border-green-800"
          : "bg-gray-800 text-gray-500 border border-gray-700"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-green-400" : "bg-gray-600"}`} />
      {label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-900 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-700/60 bg-gray-800/40">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 border-b border-gray-800/50 last:border-0">
      <dt className="text-xs text-gray-500 shrink-0">{label}</dt>
      <dd className="text-xs text-gray-200 text-right truncate max-w-xs">{value}</dd>
    </div>
  );
}

function UsageBar({ pct }: { pct?: number }) {
  if (pct == null) return null;
  const color =
    pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-400 tabular-nums w-8 text-right">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ── GPU card ──────────────────────────────────────────────────────────────────

function GpuCard({ gpu }: { gpu: SystemGpu }) {
  if (!gpu.available) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-4 text-center">
        <p className="text-xs text-gray-500">No GPU / CUDA unavailable</p>
        {gpu.reason && <p className="text-[10px] text-gray-600 mt-1">{gpu.reason}</p>}
      </div>
    );
  }

  const vramUsedPct =
    gpu.vram_total_gb && gpu.vram_free_gb != null
      ? ((gpu.vram_total_gb - gpu.vram_free_gb) / gpu.vram_total_gb) * 100
      : undefined;

  return (
    <div className="rounded-lg border border-green-800/50 bg-green-950/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white">{gpu.name ?? "GPU"}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">
            CUDA {gpu.cuda_capability} · {gpu.sm_count} SMs
          </p>
        </div>
        <Badge ok label="GPU" />
      </div>

      <dl className="space-y-1">
        <Row label="VRAM total"    value={`${gpu.vram_total_gb} GB`} />
        {gpu.vram_free_gb != null && (
          <Row label="VRAM free" value={`${gpu.vram_free_gb.toFixed(2)} GB`} />
        )}
        {vramUsedPct != null && (
          <div className="pt-0.5">
            <p className="text-[10px] text-gray-500 mb-1">VRAM usage</p>
            <UsageBar pct={vramUsedPct} />
          </div>
        )}
        {gpu.util_gpu_pct != null && (
          <div className="pt-0.5">
            <p className="text-[10px] text-gray-500 mb-1">GPU utilisation</p>
            <UsageBar pct={gpu.util_gpu_pct} />
          </div>
        )}
        {gpu.temp_celsius != null && (
          <Row
            label="Temperature"
            value={
              <span className={gpu.temp_celsius > 85 ? "text-red-400" : gpu.temp_celsius > 70 ? "text-yellow-400" : "text-green-400"}>
                {gpu.temp_celsius}°C
              </span>
            }
          />
        )}
        {gpu.cuda_version && <Row label="CUDA version"  value={gpu.cuda_version} />}
        {gpu.torch_version && <Row label="PyTorch"       value={gpu.torch_version} />}
      </dl>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const CAPABILITY_LABELS: Record<string, string> = {
  player_detection:  "Player Detection",
  pose_estimation:   "Pose Estimation",
  skeleton_overlay:  "Skeleton Overlay",
  court_heatmap:     "Court Heatmap",
  shuttle_tracking:  "Shuttle Tracking",
  gpu_inference:     "GPU Inference",
  court_calibration: "Court Calibration",
  coaching_llm:      "Coaching LLM",
};

export default function ProfilePage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const data = await apiClient.getSystemInfo();
      setInfo(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-gray-500 animate-pulse">Loading system info…</p>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
        {error || "Could not load system info."}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">System Profile</h1>
          <p className="text-sm text-gray-400 mt-1">
            Hardware, models, and capability status for this Badminton AI Coach instance.
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="rounded border border-gray-600 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:border-gray-500 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {/* Capability badges */}
      <Section title="Feature Capabilities">
        <div className="flex flex-wrap gap-2">
          {Object.entries(info.capabilities).map(([key, ok]) => (
            <Badge key={key} ok={ok} label={CAPABILITY_LABELS[key] ?? key.replace(/_/g, " ")} />
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* GPU */}
        <Section title={`GPU${info.gpus.length > 1 ? "s" : ""} · ${info.gpus.length} detected`}>
          <div className="space-y-3">
            {info.gpus.map((g, i) => <GpuCard key={i} gpu={g} />)}
          </div>
        </Section>

        {/* CPU */}
        <Section title="CPU">
          <dl className="space-y-1">
            <Row label="Model"          value={info.cpu.name} />
            <Row label="Physical cores" value={info.cpu.physical_cores ?? "—"} />
            <Row label="Logical cores"  value={info.cpu.logical_cores ?? "—"} />
            {info.cpu.freq_mhz_max != null && (
              <Row label="Max frequency" value={`${info.cpu.freq_mhz_max.toLocaleString()} MHz`} />
            )}
          </dl>
          {info.cpu.usage_pct != null && (
            <div className="mt-3">
              <p className="text-[10px] text-gray-500 mb-1">Current usage</p>
              <UsageBar pct={info.cpu.usage_pct} />
            </div>
          )}
        </Section>

        {/* RAM */}
        <Section title="Memory (RAM)">
          <dl className="space-y-1">
            <Row label="Total"     value={`${info.ram.total_gb ?? "—"} GB`} />
            <Row label="Used"      value={`${info.ram.used_gb ?? "—"} GB`} />
            <Row label="Available" value={`${info.ram.available_gb ?? "—"} GB`} />
          </dl>
          {info.ram.usage_pct != null && (
            <div className="mt-3">
              <p className="text-[10px] text-gray-500 mb-1">Usage</p>
              <UsageBar pct={info.ram.usage_pct} />
            </div>
          )}
        </Section>

        {/* Disk */}
        <Section title="Storage">
          {info.disk.path ? (
            <>
              <dl className="space-y-1">
                <Row label="Path"  value={<span className="font-mono text-[10px]">{info.disk.path}</span>} />
                <Row label="Total" value={`${info.disk.total_gb} GB`} />
                <Row label="Used"  value={`${info.disk.used_gb} GB`} />
                <Row label="Free"  value={`${info.disk.free_gb} GB`} />
              </dl>
              {info.disk.usage_pct != null && (
                <div className="mt-3">
                  <p className="text-[10px] text-gray-500 mb-1">Usage</p>
                  <UsageBar pct={info.disk.usage_pct} />
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500">Disk info unavailable.</p>
          )}
        </Section>
      </div>

      {/* Platform + Python */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Platform">
          <dl className="space-y-1">
            <Row label="OS"       value={`${info.platform.os} ${info.platform.os_release}`} />
            <Row label="Hostname" value={info.platform.hostname} />
            <Row label="Machine"  value={info.platform.machine} />
            <Row label="Version"  value={<span className="font-mono text-[10px] truncate">{info.platform.os_version}</span>} />
          </dl>
        </Section>

        <Section title="Python Runtime">
          <dl className="space-y-1">
            <Row label="Version"        value={`${info.python.implementation} ${info.python.version}`} />
            <Row label="Executable"     value={<span className="font-mono text-[10px] truncate">{info.python.executable}</span>} />
          </dl>
        </Section>
      </div>

      {/* AI Models */}
      <Section title="AI Models">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Object.entries(info.models).map(([key, model]) => (
            <div
              key={key}
              className={`rounded-lg border p-4 space-y-2 ${
                model.available
                  ? "border-green-800/50 bg-green-950/20"
                  : "border-gray-700 bg-gray-800/40 opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">{model.name}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{model.task}</p>
                </div>
                <Badge ok={model.available} label={model.available ? "Ready" : "Missing"} />
              </div>
              {!model.available && (
                <p className="text-[10px] text-yellow-500">
                  Weights not found — shuttle tracking disabled.
                </p>
              )}
              {model.weights_path && (
                <p className="text-[10px] text-gray-600 font-mono truncate">{model.weights_path}</p>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* Vision Config */}
      <Section title="Analysis Configuration">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-1">
          {Object.entries(info.config).map(([key, value]) => (
            <Row
              key={key}
              label={key.replace(/_/g, " ")}
              value={String(value)}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
