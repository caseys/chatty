// ============================================================================
// Fluid HiDPI Audio Waveform Visualizer
// High-efficiency, retina-crisp, mobile-optimized audio bar visualizer
// ============================================================================

export interface VisualizerConfig {
  barCount?: number;
  barWidth?: number;
  gap?: number;
  minBarHeight?: number;
  /** Display-only multiplier for the level (e.g. to make a quiet source read louder) */
  gain?: number;
  gradientColors: [string, string, string];
  glowColor: string;
}

export class FluidAudioVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private config: Required<VisualizerConfig>;
  private smoothedBars: Float32Array;
  private phase = 0;

  constructor(canvas: HTMLCanvasElement, config: VisualizerConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.config = {
      barCount: config.barCount ?? 28,
      barWidth: config.barWidth ?? 3.5,
      gap: config.gap ?? 4,
      minBarHeight: config.minBarHeight ?? 3.5,
      gain: config.gain ?? 1,
      gradientColors: config.gradientColors,
      glowColor: config.glowColor,
    };
    this.smoothedBars = new Float32Array(this.config.barCount);
    this.smoothedBars.fill(this.config.minBarHeight);
  }

  render(pcm: Float32Array, rawRms: number, isActive: boolean): void {
    if (!this.ctx) return;
    const gain = this.config.gain;
    const rms = rawRms * gain;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || 320;
    const cssH = rect.height || 48;

    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    this.phase += isActive ? 0.08 : 0.035;

    // As many bars as fit, so the waveform spans the whole width
    const step = this.config.barWidth + this.config.gap;
    const count = Math.max(8, Math.floor((cssW + this.config.gap) / step));
    if (count !== this.smoothedBars.length) {
      const resized = new Float32Array(count).fill(this.config.minBarHeight);
      resized.set(this.smoothedBars.subarray(0, Math.min(count, this.smoothedBars.length)));
      this.smoothedBars = resized;
    }
    const totalBarWidth = count * this.config.barWidth + (count - 1) * this.config.gap;
    const startX = (cssW - totalBarWidth) / 2;
    const centerY = cssH / 2;

    // Linear gradient across vertical height
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, this.config.gradientColors[0]);
    grad.addColorStop(0.5, this.config.gradientColors[1]);
    grad.addColorStop(1, this.config.gradientColors[2]);

    ctx.fillStyle = grad;
    if (isActive && rms > 0.008) {
      ctx.shadowColor = this.config.glowColor;
      ctx.shadowBlur = 8;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    const midIdx = count / 2;

    for (let i = 0; i < count; i++) {
      // Parabolic center-weight window (center bars expand more dynamically than outer edges)
      const distFromCenter = Math.abs(i - midIdx) / midIdx;
      const windowWeight = Math.max(0.25, 1 - distFromCenter * distFromCenter * 0.75);

      // Map to audio sample slice
      const pcmIdx = Math.min(pcm.length - 1, Math.floor((i / count) * pcm.length));
      const sampleMag = Math.abs(pcm[pcmIdx] ?? 0) * gain;

      let targetHeight = this.config.minBarHeight;
      if (isActive && rms > 0.005) {
        const audioAmp = (rms * 2.4 + sampleMag * 0.7) * windowWeight;
        targetHeight = Math.min(cssH - 4, Math.max(this.config.minBarHeight, audioAmp * cssH * 1.6));
      } else {
        // Living breathing ripple when resting
        const idleWave = Math.sin(this.phase + i * 0.32) * 0.5 + 0.5;
        targetHeight = this.config.minBarHeight + idleWave * 3.2;
      }

      // Smooth spring lerp for silky ProMotion 60-120fps motion
      this.smoothedBars[i] += (targetHeight - this.smoothedBars[i]) * (isActive ? 0.32 : 0.12);

      const barH = Math.max(this.config.minBarHeight, this.smoothedBars[i]);
      const x = startX + i * (this.config.barWidth + this.config.gap);
      const y = centerY - barH / 2;
      const radius = this.config.barWidth / 2;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, this.config.barWidth, barH, radius);
      } else {
        ctx.rect(x, y, this.config.barWidth, barH);
      }
      ctx.fill();
    }

    ctx.restore();
  }
}
