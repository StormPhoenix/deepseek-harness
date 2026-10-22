/**
 * Script-action capability seam of the Schedule domain: providers register a
 * kind, validate its specification, and run it once under a resolved policy.
 * @module @deepseek-ai/dsh-schedule
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ScheduleInputError } from './domain.ts'

/** Execution context one run receives; every value is resolved before the provider runs. */
export interface ScheduleActionEnv {
  /** The bound Session's current policy, narrowed to the task's creation-time ceiling. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Absolute working directory captured at creation. */
  readonly cwd: string
  /** Elapsed budget after Host defaulting and capping. */
  readonly timeoutMs: number
  /** Fires on task deletion, archive stop, or Host disposal. */
  readonly signal: AbortSignal
}

/** Provider-reported terminal outcome of one run; the Host truncates and saves it. */
export interface ScheduleActionResult {
  /** Classification a provider can observe, including an unavailable execution language or substrate. */
  readonly outcome: 'succeeded' | 'failed' | 'timeout' | 'aborted' | 'sandbox-denied' | 'unavailable'
  /** Process exit code, for actions that run one process. */
  readonly exitCode?: number | null
  /** Complete captured output; the Host applies its byte budget. */
  readonly output: string
  /** Whether the provider's own capture already dropped bytes. */
  readonly outputTruncated?: boolean
}

/**
 * One script-action kind. Providers register through
 * {@link ScheduleActionRegistry.register}; the Host owns timing, storage,
 * reporting, and cancellation, and the provider owns its specification.
 */
export interface ScheduleActionProvider {
  /** Kind stored on task rows; also the tool consumer's discriminator. */
  readonly kind: string
  /** Model-facing description of what this kind runs and how its output is captured. */
  readonly description: string
  /** Tool DSL schema of the specification object; required properties use `required: true`. */
  readonly specSchema: ValueSchemaSpec
  /**
   * Validate untrusted input at creation and at run time.
   * @param spec - Model or durable specification.
   * @returns The canonical specification the Host stores.
   * @throws ScheduleInputError with `invalid_action` when the specification is invalid.
   */
  decode(spec: unknown): JsonValue
  /**
   * Render the stored specification for read-only display and update comparison.
   * @param spec - Canonical specification returned by decode.
   * @returns The complete source text the action runs.
   */
  source(spec: JsonValue): string
  /**
   * Run once. Failures of the action resolve as outcomes; only provider contract misuse rejects.
   * @param spec - Canonical specification returned by decode.
   * @param env - Resolved policy, directory, budget, and cancellation.
   * @returns The terminal outcome and captured output.
   */
  run(spec: JsonValue, env: ScheduleActionEnv): Promise<ScheduleActionResult>
}

/** Mounted providers keyed by kind; one provider per kind. */
export class ScheduleActionRegistry {
  private readonly providers = new Map<string, ScheduleActionProvider>()

  /** @param onChange - Called after every registration change. */
  constructor(private readonly onChange: () => void) {}

  /**
   * Register one provider kind.
   * @param provider - Provider to mount.
   * @returns Disposer that unmounts exactly this registration.
   * @throws When the kind is empty or already registered.
   */
  register(provider: ScheduleActionProvider): () => void {
    if (provider.kind.trim().length === 0 || provider.kind.trim() !== provider.kind) {
      throw new Error('schedule: an action provider kind must be non-empty without surrounding whitespace')
    }
    if (this.providers.has(provider.kind)) {
      throw new Error(`schedule: an action provider for kind "${provider.kind}" is already registered`)
    }
    this.providers.set(provider.kind, provider)
    this.onChange()
    return () => {
      if (this.providers.get(provider.kind) !== provider) return
      this.providers.delete(provider.kind)
      this.onChange()
    }
  }

  /**
   * Look up the provider currently mounted for an action kind.
   * @param kind - Stored or requested kind.
   * @returns The mounted provider, or undefined.
   */
  get(kind: string): ScheduleActionProvider | undefined {
    return this.providers.get(kind)
  }

  /**
   * Snapshot the currently mounted providers.
   * @returns Mounted providers in registration order.
   */
  list(): ScheduleActionProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Resolve a requested kind for creation or replacement.
   * @param kind - Requested kind.
   * @returns The mounted provider.
   * @throws ScheduleInputError with `action_unavailable` when no provider is mounted.
   */
  require(kind: string): ScheduleActionProvider {
    const provider = this.providers.get(kind)
    if (provider === undefined) {
      throw new ScheduleInputError('action_unavailable', `No script action provider for kind "${kind}" is mounted.`)
    }
    return provider
  }
}

const MODE_RANK: Readonly<Record<SandboxMode, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/**
 * Narrow a Session's current policy to a task's creation-time ceiling.
 * @param policy - The bound Session's resolved policy.
 * @param ceiling - Widest mode the task was approved under.
 * @returns The policy with the narrower of the two modes.
 */
export function narrowSandboxPolicy(policy: SandboxExecutionPolicy, ceiling: SandboxMode): SandboxExecutionPolicy {
  return MODE_RANK[ceiling] < MODE_RANK[policy.mode] ? { ...policy, mode: ceiling } : policy
}

/**
 * Keep the tail of an output within a UTF-8 byte budget, as shell capture does.
 * @param output - Complete text.
 * @param maxBytes - Positive byte budget.
 * @returns The retained tail and whether bytes were dropped.
 */
export function truncateOutput(output: string, maxBytes: number): { output: string; truncated: boolean } {
  const bytes = Buffer.from(output, 'utf8')
  if (bytes.length <= maxBytes) return { output, truncated: false }
  let start = bytes.length - maxBytes
  // A UTF-8 continuation byte starts with 0b10; advance to the next character boundary.
  while (start < bytes.length && (bytes.readUInt8(start) & 0xC0) === 0x80) start += 1
  return { output: bytes.subarray(start).toString('utf8'), truncated: true }
}

/**
 * Render a stored specification when its provider is not mounted.
 * @param spec - Opaque stored specification.
 * @returns Its JSON text.
 */
export function fallbackSource(spec: JsonValue): string {
  return JSON.stringify(spec)
}
