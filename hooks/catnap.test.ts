import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import {
  NAME,
  NAP_REPLY,
  PASTE_MAX,
  PERSON_EACH,
  SKILL_EACH,
  SKILL_MAX,
  asksToCompact,
  autoTarget,
  capped,
  fromOptions,
  isHeadlessRefusal,
  keepSaid,
  keepSkills,
  parseConfig,
  proseHandoff,
  skillsIn,
} from './register'

// The tool's full name, spelled out here and NOT taken from register.ts, so a rename that reaches only one of the two
// files shows up: the tests under "the name trap" at the end check it against what the engine says the plugin is called.
const TOOL = 'mcp__catnap__compact_now'
const FLAG = /state\/catnap\/sess-1\.json$/
const slash = (p: string) => p.split('\\').join('/') // the engine hands paths over with backslashes on Windows

type World = {
  pct: number | undefined
  window: number // the model's context window in tokens
  surfaces: RenderSurface[]
  files: Map<string, string>
  prompts: string[]
  compacts: (string | undefined)[]
  compactFailures: number
  headless: boolean // $.session.compact refused as in the desktop app's SDK session; a /compact prompt works
  triggers: (string | undefined)[] // every session.compact that reached the engine, by trigger
  commands: string[] // every slash command run, as typed
  commandMode: 'done' | 'hold' | 'refuse' // a command finishes at once, waits for release(), or is refused
  toasts: string[]
  descriptions: string[] // every registered tool's description
  preCompacts: (string | undefined)[] // every compaction that ran the person's PreCompact hooks (core's), by trigger
  reached: { trigger?: string; instructions?: string; n: number }[] // every session.compact that reached the engine
  preCompactBlock: string | null // a PreCompact hook blocks: core answers with this skip, word for word
  oneSummarized: boolean // an engine that summarizes a one-message transcript instead of refusing it
}

// Everything beneath the plugin: the engine's answers, held in memory.
const world = (on: On, init: Partial<World> = {}, fixture: Record<string, string> = { USERPROFILE: 'C:\\Users\\tester' }) => {
  const w: World = {
    pct: 10,
    // 200K: the percent lines come first there, as before 0.3.11; the token lines have their own tests on 1M
    window: 200_000,
    surfaces: ['desktop'],
    files: new Map(),
    prompts: [],
    compacts: [],
    compactFailures: 0,
    headless: false,
    triggers: [],
    commands: [],
    commandMode: 'done',
    toasts: [],
    descriptions: [],
    preCompacts: [],
    reached: [],
    preCompactBlock: null,
    oneSummarized: false,
    ...init,
  }
  const clock = mock.clock(on)
  // the process environment, read and written (mock.env answers reads only). The starting record is called
  // `fixture`: under its old name the directory's checker took listing it for listing the real environment and held
  // the plugin for "uses a credential" (found 2026-10-17 by elimination on probe branches)
  const vars = new Map(Object.entries(fixture))
  on('env.get', ($, e) => ({ value: vars.get(e.name) }))
  on('env.set', ($, e) => {
    if (vars.has('TEST_REFUSE_ENV_SET')) throw new Error('env writes are not allowed here')
    if (vars.has('TEST_HOLD_ENV_SET')) return { value: { deny: 'held: this session takes its settings from its organization' } }
    if (e.value === undefined) vars.delete(e.name)
    else vars.set(e.name, e.value)
    return { value: {} } // written (since 2.1.302 a held write resolves { deny } instead of rejecting)
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context:
        w.pct === undefined
          ? { window: w.window }
          : { window: w.window, tokens: (w.pct * w.window) / 100, percent: w.pct },
      rateLimits: [],
    },
  }))
  on('fs.read', ($, e) => {
    const want = slash(e.path).replace(/^.*\/state\//, '/state/')
    const text = [...w.files].find(([p]) => slash(p).endsWith(want))?.[1]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => {
    w.descriptions.push(String(e.description ?? ''))
    return { value: { tool: `mcp__catnap__${e.name}` } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind !== 'composer' && e.origin?.kind !== 'sdk') w.prompts.push(e.text) // the mod's own, not the person's
    return { text: e.text }
  })
  on('session.compact', ($, e) => {
    w.triggers.push(e.trigger)
    w.reached.push({ trigger: e.trigger, instructions: e.instructions, n: e.messages?.length ?? 0 })
    // a plugin's own call reaches the test's bottom with no trigger
    if (w.headless && (e.trigger === undefined || e.trigger === 'plugin')) {
      // the live 2026-10-13 refusal, word for word
      throw new Error(
        'HooksError: catnap: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
      )
    }
    if (w.compactFailures > 0) {
      w.compactFailures -= 1
      throw new Error('a turn is running')
    }
    // core, as probed live on 2.1.304 (2026-10-22): the person's PreCompact hooks run first, a blocking one answers
    // with a skip, and a transcript of one message is refused after them, with no model call
    w.preCompacts.push(e.trigger)
    if (w.preCompactBlock !== null) return { skip: w.preCompactBlock }
    if ((e.messages?.length ?? 2) < 2 && !w.oneSummarized) throw new Error('Not enough messages to compact.')
    w.compacts.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 640_000, tokensAfter: 40_000 }
  })
  const held: (() => void)[] = []
  on('command.run', ($, e) => {
    w.commands.push(`/${e.command} ${e.args}`)
    if (w.commandMode === 'refuse') throw new Error('no such command')
    if (w.commandMode === 'hold') return new Promise(resolve => held.push(() => resolve({ text: 'Compacted.' })))
    return { text: 'Compacted.' }
  })
  const release = () => held.splice(0).forEach(f => f())
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('skill.prompt', ($, e) => ({ text: e.text })) // the skill's text as loaded
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const flag = () => {
    const hit = [...w.files].filter(([p]) => FLAG.test(slash(p))).pop() // the newest, whatever its slashes
    return hit ? (JSON.parse(hit[1]) as { pending: boolean; handoff: string | null }) : undefined
  }
  return { w, clock, flag, release, vars }
}

// The person types a prompt (at the terminal unless `kind` says otherwise).
const say = ($: Engine, text: string, kind: 'composer' | 'sdk' | 'plugin' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: kind === 'plugin' ? { kind, name: 'catnap', asUser: false } : { kind } } as never)

// A session where the person has asked for a compaction (/catnap:compact), so compact_now is taken at any percent:
// what most tests below need. startQuiet: no such ask, so compact_now is held to the line.
const startQuiet = ($: Engine) => $.session.start({ cwd: '.', surface: 'desktop', isInteractive: false })
const start = async ($: Engine) => {
  const r = await startQuiet($)
  await say($, '/catnap:compact')
  return r
}

const read = { tool: 'Read', file_path: 'a.txt' } as const

// Claude Code's own summary at each nap: the handoff_summary option off, as every nap ran before 0.3.9. The tests
// that run with it are about that path (the direct $.session.compact, its retries, the full continue prompt); the
// default path has its own tests under "handoff summary" at the end.
const ENGINE_SUMMARY = { options: { handoff_summary: false } }

test('below the soft line a tool result carries no note', async ($, on) => {
  const { w } = world(on, { pct: 49 })
  await start($)
  const r = await $.tool.call(read)
  expect(r.context ?? []).toEqual([])
  expect(w.prompts).toEqual([])
})

test('at the soft line the soft note lands once, then the strict note at the line', async ($, on) => {
  const { w } = world(on, { pct: 50 })
  await start($)
  const soft = (await $.tool.call(read)).context?.[0] ?? ''
  expect(soft).toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  expect(soft).toMatch(/Finish the piece you are on, and finish it properly/)
  expect(soft).toMatch(/write your handoff, call mcp__catnap__compact_now with your handoff as note/)
  expect(soft).toMatch(
    /\n- Make that call in the same response as the piece's last action \(for example the command that runs the tests\), as its last tool call, not in a reply of its own/,
  )
  expect(soft).toMatch(/You will not see that action's result before the compaction, so your handoff's next step starts with checking it\.\n/)
  expect(soft).not.toMatch(/save-before-compact/)
  expect(soft).toMatch(/compact_now/)
  expect(soft).not.toMatch(/do not wait for a better moment/)
  w.pct = 55
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 59
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 60
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 60% of the window \(the line is 60%\)\. Save and compact now/)
})

test('a turn that ends between the soft line and the line gets no ask', async ($, on) => {
  const { w, clock } = world(on, { pct: 55 })
  await start($)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

test('a jump straight past the line skips the soft note', async ($, on) => {
  world(on, { pct: 65 })
  await start($)
  const first = (await $.tool.call(read)).context ?? []
  expect(first.length).toBe(1)
  expect(first[0] ?? '').toMatch(/Save and compact now/)
  expect(first[0] ?? '').not.toMatch(/comfortable moment/)
})

test('a soft line at or above the line is off', async ($, on) => {
  const { w } = world(on, { pct: 55 })
  w.files.set('X/state/catnap/config.json', '{"soft": 60, "threshold": 60}')
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('after a compaction the soft note comes back in the next cycle', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 8
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 51
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 51% of the window\. Compact at a comfortable moment/)
})

test('past the line the note lands once, then again two points later', async ($, on) => {
  const { w } = world(on, { pct: 61 })
  await start($)
  const first = await $.tool.call(read)
  expect(first.context?.[0] ?? '').toMatch(/Context is at 61% of the window \(the line is 60%\)/)
  expect(first.context?.[0] ?? '').toMatch(/do not wait for a better moment/)
  expect(first.context?.[0] ?? '').toMatch(/write your handoff \(the task, what is done, the next step, open decisions, the files that matter, and every instruction from the person that still applies, in their words\) straight into the note/)
  expect(first.context?.[0] ?? '').toMatch(/3\. Call mcp__catnap__compact_now with your handoff as note/)
  expect(first.context?.[0] ?? '').toMatch(
    /as keep\. Make that call in the same response as the step's last action \(for example the command that runs the tests\), as its last tool call, not in a reply of its own: a reply of its own reads the whole conversation once more\./,
  )
  expect(first.context?.[0] ?? '').toMatch(/so your handoff's next step starts with checking it\. If the step is already done, call it now\.\n4\. /)
  expect(first.context?.[0] ?? '').toMatch(/End your reply right there/)
  w.pct = 62
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 63
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 63%/)
})

test('compact_now queues, the turn end compacts, then a continue prompt is sent', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64 })
  await start($)
  const q = await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  expect(String(q.result)).toMatch(/Compaction queued\. End your reply now/)
  expect(q.context ?? []).toEqual([]) // its own answer, with no note added past the line
  // a second call while queued is answered by the mod again, still with no note
  expect((await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(flag()?.pending).toBe(true)
  // a tool call after queueing is told to stop
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Compaction is queued\. End your reply now/)
  expect(w.compacts).toEqual([]) // nothing runs mid-turn
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0] ?? '').toMatch(/the mod build/)
  expect(w.compacts[0] ?? '').toMatch(/x\.md/)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request \(context had reached 64%\)/)
  expect(w.prompts[0] ?? '').toMatch(/x\.md/)
  expect(flag()?.pending).toBe(false)
})

test('a compaction refused while a turn runs is retried', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64, compactFailures: 2 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(0)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(0)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
})

test('an interrupted turn keeps the compaction queued until a normal turn end', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'aborted', isAborted: true, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.compacts.length).toBe(0)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
})

test('a turn that ends past the line without compact_now gets an ask, repeated only five points later', async ($, on) => {
  const { w, clock } = world(on, { pct: 65 })
  await start($)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your last turn ended with context at 65%/)
  expect(w.prompts[0] ?? '').toMatch(/compact_now/)
  expect(w.prompts[0] ?? '').toMatch(/Make that call in the same response as the step's last action .*If the step is already done, call it now\./)
  w.pct = 68
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  w.pct = 70
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't3', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(2)
})

test('a run where nothing draws (-p, delegate legs) is never touched', async ($, on) => {
  const { w, clock } = world(on, { pct: 90, surfaces: [] })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

// The desktop app attaches its window to a chat and detaches it again: a long turn there crossed 50% and 60% with no
// note while nothing was attached (live 2026-10-17). Its chats are known by the entry point instead.
const DESKTOP = { USERPROFILE: 'C:\\Users\\tester', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }

test('a desktop app chat with no window attached still gets both notes, the ask, its log and the auto line', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 55, surfaces: [] }, DESKTOP)
  await start($)
  await clock.advance(1600)
  expect(vars.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('70')
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 55% of the window\. Compact at a comfortable moment/)
  w.pct = 62
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 60%/)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your last turn ended with context at 62%/)
  expect([...w.files.keys()].map(slash).filter(p => /sess-1\.log\.json$/.test(p)).length).toBeGreaterThan(0)
})

test('a desktop app chat whose window goes away mid-turn keeps getting notes', async ($, on) => {
  const { w } = world(on, { pct: 45 }, DESKTOP)
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.surfaces = []
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 60%/)
})

// A claude -p started from inside a desktop chat inherits its entry point, but the engine also sets CLAUDECODE and
// CLAUDE_CODE_CHILD_SESSION for what it starts (seen live 2026-10-17); either one alone keeps the mod out.
for (const [what, extra] of [
  ['CLAUDECODE', { CLAUDECODE: '1' }],
  ['CLAUDE_CODE_CHILD_SESSION', { CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a plain -p run (sdk-cli)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
] as const) {
  test(`a run started from inside a chat is never touched: ${what}`, async ($, on) => {
    const { w, clock, vars } = world(on, { pct: 90, surfaces: [] }, { ...DESKTOP, ...extra, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '55' })
    await start($)
    expect((await $.tool.call(read)).context ?? []).toEqual([])
    await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
    await clock.advance(3200)
    expect(w.prompts).toEqual([])
    expect(w.compacts).toEqual([])
    expect(vars.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('55')
    expect([...w.files.keys()].filter(p => /\.log\.json$/.test(p))).toEqual([])
  })
}

test('subagents get no note and may not compact', async ($, on) => {
  const { w } = world(on, { pct: 90 })
  await start($)
  expect((await $.tool.call({ ...read, agentId: 'a1' } as never)).context ?? []).toEqual([])
  const denied = await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k', agentId: 'a1' } as never)
  expect(denied.deny ?? '').toMatch(/Only the main conversation/)
  expect(w.compacts).toEqual([])
})

test('the config file switches it off and moves the line; a per-session file wins', async ($, on) => {
  const { w } = world(on, { pct: 30 })
  w.files.set('X/state/catnap/config.json', '{"threshold": 25}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 25%/)
  w.files.set('X/state/catnap/sess-1.config.json', '{"off": true}')
  w.pct = 40
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('compact_now with neither a note nor a handoff path is refused', async ($, on) => {
  const { w } = world(on, { pct: 64 })
  await start($)
  const r = await $.tool.call({ tool: TOOL, note: ' ', handoff: '  ', keep: 'k' } as never)
  expect(r.deny ?? '').toMatch(/Write your handoff first and pass it as note/)
  expect([...w.files.keys()].some(k => /handoff\.md$/.test(k))).toBe(false)
})

test('wrapper children (CLAUDE_DELEGATE_LEG) are never touched, even with a surface', async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\\Users\\tester', CLAUDE_DELEGATE_LEG: 'glm' })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
})

test('CLAUDE_STATE_DIR moves the state folder, as it does for the settings hooks', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 }, { USERPROFILE: 'C:\\Users\\tester', CLAUDE_STATE_DIR: 'D:\\st' })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await clock.advance(1600)
  expect([...w.files.keys()].map(slash)).toContain('D:/st/catnap/sess-1.json')
})

const MSGS = [
  { role: 'user' as const, text: 'summary', toolUses: [] },
  { role: 'assistant' as const, text: 'ok', toolUses: [] },
]

const turnEnd = ($: Engine, turnId: string) =>
  $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })

const LIVE_REFUSAL =
  'HooksError: catnap: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

test("the desktop app's refusal is recognised; a busy refusal is not", () => {
  expect(isHeadlessRefusal(new Error(LIVE_REFUSAL))).toBe(true)
  expect(isHeadlessRefusal(LIVE_REFUSAL)).toBe(true)
  expect(isHeadlessRefusal(new Error('a turn is running'))).toBe(false)
  expect(isHeadlessRefusal(undefined)).toBe(false)
})

// The test kit hands the plugin its own error text for a refused call, so these reach /compact by the count.
const queueAndEnd = async ($: Engine) => {
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  await turnEnd($, 't1')
}

test('where direct compaction is refused (the desktop app), /compact runs and the continue follows its landing', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock, flag, release } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 2 + 100)
  expect(w.commands).toEqual([]) // two refusals: still trying directly
  await clock.advance(1500)
  expect(w.triggers.length).toBe(3)
  expect(w.commands.length).toBe(1)
  expect(w.commands[0] ?? '').toMatch(/^\/compact Keep what the next turn needs to continue: the mod build\./)
  expect(w.commands[0] ?? '').toMatch(/x\.md/)
  expect(w.prompts).toEqual([]) // never a prompt beginning with /
  expect(flag()?.pending).toBe(true) // still queued while /compact runs
  await clock.advance(4500)
  expect(w.commands.length).toBe(1) // no second /compact while the first is out
  expect(w.triggers.length).toBe(3) // and no more direct calls
  // /compact compacts: the engine raises session.compact with trigger manual
  await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'x' } as never)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request \(context had reached 64%\)/)
  expect(flag()?.pending).toBe(false)
  release() // the command finishes after its compaction: no second continue
  await clock.advance(3200)
  expect(w.prompts.length).toBe(1)
  expect(w.toasts).toEqual([])
})

test('if no compaction is seen, the finished /compact stands for it and the continue follows', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
  expect(flag()?.pending).toBe(false)
})

test('a refused /compact gives up: toast, queued state cleared', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true, commandMode: 'refuse' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 4 + 100)
  expect(w.commands.length).toBe(1)
  expect(w.prompts).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^could not compact this chat \(\/compact was refused/) // the host adds "catnap:"
  expect(flag()?.pending).toBe(false)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('a /compact that never lands is given up after 10 minutes: toast, queued state cleared, quiet', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(10 * 60_000 + 3200)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^could not compact this chat \(\/compact did not compact within 10 minutes\)/)
  expect(flag()?.pending).toBe(false)
  // quiet: no queued note, no strict note, no ask
  w.pct = 70
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await turnEnd($, 't2')
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
})

test('a compaction landing some other way ends the give-up', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(11 * 60_000)
  expect(w.toasts.length).toBe(1)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 5 // the first check after it: the floor
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

test('a reload clears a queued flag the old module left behind', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 10 })
  w.files.set('C:/Users/tester/.claude/state/catnap/sess-1.json', '{"pending":true,"at":"2026-10-13T17:31:43.722Z","handoff":"h.md"}')
  await start($)
  await clock.advance(1600)
  expect(flag()?.pending).toBe(false)
})

test('save_step names the save command in every note, the ask and the refusal', { options: { save_step: '/save-before-compact' } }, async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/At that clean break: run \/save-before-compact, call/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/2\. Save everything a fresh start would need: run \/save-before-compact \(it writes the handoff file/)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.prompts[0] ?? '').toMatch(/run \/save-before-compact/)
  const r = await $.tool.call({ tool: TOOL, handoff: ' ', keep: 'k' } as never)
  expect(r.deny ?? '').toMatch(/Save everything first \(run \/save-before-compact\)/)
})

test('soft_percent and strict_percent move both lines', { options: { soft_percent: 30, strict_percent: 40 } }, async ($, on) => {
  const { w } = world(on, { pct: 29 })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 30
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 30% of the window\. Compact at a comfortable moment before 40%/)
  w.pct = 40
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/\(the line is 40%\)\. Save and compact now/)
})

test('the config file still wins over the options', { options: { soft_percent: 30, strict_percent: 40 } }, async ($, on) => {
  const { w } = world(on, { pct: 45 })
  w.files.set('X/state/catnap/config.json', '{"threshold": 50}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment before 50%/)
})

// CATNAP_OFF, and the old name of the switch, which keeps working
for (const OFF of ['CATNAP_OFF', 'COMPACT_WHEN_READY_OFF'])
  test(`${OFF} switches it off, even with a surface`, async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\\Users\\tester', [OFF]: '1' })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect([...w.files.keys()]).toEqual([])
})

test('a session where nothing draws leaves no log file; one that draws does', async ($, on) => {
  const { w, clock } = world(on, { pct: 10, surfaces: [] })
  await start($)
  await clock.advance(3200)
  expect([...w.files.keys()].filter(p => /\.log\.json$/.test(p))).toEqual([])
  w.surfaces = ['desktop']
  await start($)
  await clock.advance(3200)
  expect([...w.files.keys()].map(slash).filter(p => /sess-1\.log\.json$/.test(p)).length).toBeGreaterThan(0)
})

// The auto line: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in the mod's own process.
const AUTO = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
const ORIG = 'CATNAP_AUTO_ORIG'
const HOME = { USERPROFILE: 'C:\\Users\\tester' }

test('a session that draws gets auto-compact at 70 by default, and what was there is kept', async ($, on) => {
  const { clock, vars } = world(on)
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  expect(vars.get(ORIG)).toBe('') // it was unset
})

test('auto_percent moves the auto line and wins over a value from the settings', { options: { auto_percent: 80 } }, async ($, on) => {
  const { clock, vars } = world(on, {}, { ...HOME, [AUTO]: '55' })
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('80')
  expect(vars.get(ORIG)).toBe('55')
})

test("auto_percent 0 leaves Claude Code's own setting alone", { options: { auto_percent: 0 } }, async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, [AUTO]: '55' })
  await start($)
  await $.tool.call(read)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('55')
  expect(vars.has(ORIG)).toBe(false)
})

test('config.json moves the auto line at the next check, and off puts the old value back', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 }, { ...HOME, [AUTO]: '55' })
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  w.files.set('X/state/catnap/config.json', '{"auto": 75}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('75')
  w.files.set('X/state/catnap/config.json', '{"auto": 75, "off": true}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('55')
})

test('off puts an unset variable back to unset, also after a reload', async ($, on) => {
  // a reload: the variable holds the mod's own 70, the marker says it was unset before
  const { w, clock, vars } = world(on, {}, { ...HOME, [AUTO]: '70', [ORIG]: '' })
  w.files.set('X/state/catnap/config.json', '{"off": true}')
  await start($)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
})

test('the desktop app attaches after the start: its first tool call sets the auto line', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 20, surfaces: [] })
  await start($)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
  w.surfaces = ['desktop']
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
})

test('a run where nothing draws never touches the auto line', async ($, on) => {
  const { clock, vars } = world(on, { pct: 90, surfaces: [] }, { ...HOME, [AUTO]: '55' })
  await start($)
  await $.tool.call(read)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('55')
  expect(vars.has(ORIG)).toBe(false)
})

for (const OFF of ['CATNAP_OFF', 'COMPACT_WHEN_READY_OFF'])
  test(`${OFF} leaves the auto line alone, even with a surface`, async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, [OFF]: '1' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  expect(vars.has(AUTO)).toBe(false)
})

test('a wrapper child (CLAUDE_DELEGATE_LEG) leaves the auto line alone, even with a surface', async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, CLAUDE_DELEGATE_LEG: 'glm', [AUTO]: '70' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('70')
  expect(vars.has(ORIG)).toBe(false)
})

test('an auto line at or below the strict line is kept, with one toast', { options: { auto_percent: 60 } }, async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 })
  await start($)
  await $.tool.call(read)
  await clock.advance(1600)
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('60')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^auto-compact \(60%\) is at or below the strict line \(60%\), so it runs before Claude is asked$/)
})

test('a host that refuses the variable write still gets its compaction and the continue', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 64 }, { ...HOME, TEST_REFUSE_ENV_SET: '1' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
  expect(vars.has(AUTO)).toBe(false)
  const log = [...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? ''
  expect(log.match(/auto-line-refused/g)?.length).toBe(1) // tried once, then left alone
})

test('a write the engine holds back ({ deny }, since 2.1.302) counts as refused, not as set', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 }, { ...HOME, TEST_HOLD_ENV_SET: '1' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
  const log = [...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? ''
  expect(log).not.toMatch(/"kind": "auto-line"/)
  expect(log.match(/auto-line-refused/g)?.length).toBe(1)
  expect(log).toMatch(/held: this session takes its settings from its organization/)
})

test('the auto line in the config parser and the target', () => {
  expect(parseConfig([]).auto).toBe(70)
  expect(parseConfig(['{"auto": 0}']).auto).toBe(0)
  expect(parseConfig(['{"auto": 100}', '{"auto": -1}', '{"auto": "80"}']).auto).toBe(70) // out of range or not a number
  expect(autoTarget(parseConfig(['{"auto": 65}']), '55')).toEqual({ value: '65', restore: false })
  expect(autoTarget(parseConfig(['{"auto": 0}']), '55')).toEqual({ value: '55', restore: true })
  expect(autoTarget(parseConfig(['{"off": true}']), '')).toEqual({ value: undefined, restore: true })
})

// The fallback for a compaction the session.compact hook does not report (a seated sec-default holds that hook back:
// anthropics/claude-code#102134). Here the hook is simply never raised, as there.
type LogEvent = {
  kind: string
  via?: string
  from?: number
  to?: number
  trigger?: string
  floor?: number
  soft?: number
  threshold?: number
  percent?: number
  line?: number
  own?: boolean
  outcome?: string
  reason?: string
}
const logOf = (w: World): LogEvent[] =>
  JSON.parse([...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? '[]') as LogEvent[]
const elsewhere = (w: World) => logOf(w).filter(e => e.kind === 'compacted-elsewhere')

test('a sharp drop in context, with no hook, starts the note cycle over and is logged once', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1) // the ask at 61
  // auto-compact inside the next turn: no hook, only the context that fell
  w.pct = 5
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 6
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.via, e.from, e.to])).toEqual([['drop', 61, 5]])
  // a fresh cycle: the soft note again, the strict note at once, the ask without waiting five points
  w.pct = 51
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 51% of the window\. Compact at a comfortable moment/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61%/)
  w.pct = 62
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1] ?? '').toMatch(/Your last turn ended with context at 62%/)
})

test('a dip under 20 points is not a compaction; 20 points is', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61%/)
  w.pct = 42 // 19 points
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 52
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no soft note: still the same cycle
  w.pct = 62
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // the strict note still waits for 63
  await clock.advance(1600)
  expect(elsewhere(w)).toEqual([])
  w.pct = 42 // 20 points
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.from, e.to])).toEqual([[62, 42]])
})

test('the check right after a compaction has no percent: the next one with a number compares', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  w.pct = undefined
  await $.tool.call(read)
  w.pct = 7
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.from, e.to])).toEqual([[61, 7]])
})

test("the mod's own direct compaction is not counted again as a drop", ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 4
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(logOf(w).filter(e => e.kind === 'compacted').length).toBe(1)
  expect(elsewhere(w)).toEqual([])
  expect(w.prompts.length).toBe(1) // the continue, and nothing else
})

test('a /compact of the mod that only its command result reports is not counted again as a drop', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(1600)
  w.pct = 4
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(logOf(w).filter(e => e.kind === 'compacted').map(e => e.via)).toEqual(['command-result'])
  expect(elsewhere(w)).toEqual([])
  expect(w.prompts.length).toBe(1)
})

test("a drop while the mod's own /compact is out does not cut it short", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  w.pct = 3 // it compacted; the command has not finished yet
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(elsewhere(w)).toEqual([])
  release()
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
})

test('a compaction the hook reports is logged once, not again as a drop', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 5
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => e.trigger ?? e.via)).toEqual(['auto'])
})

test('a drop ends a give-up when the hook is silent', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(11 * 60_000)
  expect(w.toasts.length).toBe(1)
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // given up: quiet
  w.pct = 5 // auto-compact, unreported
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

// The name trap: the tool's full name is built from the plugin's name ($.plugin.name, from plugin.json), the tool.call
// matcher that answers it is a regex literal in register.ts (it has to be one: `claude plugin validate` reads it
// statically), and NAME is the constant the rest of the module uses. If any of them differs, Claude's call to the tool
// goes unanswered while every other test here still passes. The notes tell Claude which name to call, so they show
// what the engine thinks the plugin is called.
const advertised = async ($: Engine) => {
  await start($)
  const note = (await $.tool.call(read)).context?.[0] ?? ''
  return /[Cc]all (mcp__\S+) with/.exec(note)?.[1] ?? ''
}

test('plugin.json, NAME and this file agree on the tool name the notes tell Claude to call', async ($, on) => {
  world(on, { pct: 61 })
  const name = await advertised($)
  expect(name).toBe(TOOL) // the name the engine gives the plugin (plugin.json)
  expect(name).toBe(`mcp__${NAME}__compact_now`)
})

test('a call to the advertised tool name is answered by the mod, not passed on', async ($, on) => {
  world(on, { pct: 61 })
  const name = await advertised($)
  const r = await $.tool.call({ tool: name, handoff: 'h.md', keep: 'k' } as never)
  expect(JSON.stringify(r)).toMatch(/Compaction queued/)
})

test('the matcher answers the full tool name and nothing else', async ($, on) => {
  world(on, { pct: 10 })
  await start($)
  for (const other of [`${TOOL}x`, `x${TOOL}`, 'mcp__other-plugin__compact_now', 'compact_now']) {
    const r = await $.tool.call({ tool: other, handoff: 'h.md', keep: 'k' } as never)
    expect(JSON.stringify(r)).not.toMatch(/Compaction queued/)
  }
})

// A session whose fixed part (system prompt, tools, CLAUDE.md) sits near the lines: a compaction frees almost nothing,
// so for that cycle the lines sit ten points above where it left the context (live 2026-10-18: two compactions in under
// a minute, and a third queued, without this).
const floorMoves = (w: World) => logOf(w).filter(e => e.kind === 'high-floor')

test('a compaction that leaves the context near the lines lifts them ten points for that cycle, with one toast', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1) // the continue
  w.pct = 51 // the compaction freed almost nothing
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no soft note at 51
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/still at 51% right after compacting.*the next note waits for 61%/)
  w.pct = 60
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no strict note at 60 either
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1) // and no ask at 60
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61% of the window \(the line is 61%\)\. Save and compact now/)
  expect(floorMoves(w).map(e => [e.floor, e.soft, e.threshold])).toEqual([[51, 61, 61]])
})

test('a compaction that leaves 40% or less keeps the lines as set, with no toast', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 40 // 40 + 10 is the soft line itself
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 50
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  await clock.advance(1600)
  expect(w.toasts).toEqual([])
  expect(floorMoves(w)).toEqual([])
})

test('an auto-compaction or an unreported drop sets the floor too; the next compaction sets a new one', async ($, on) => {
  const { w, clock } = world(on, { pct: 75 })
  await start($)
  await $.tool.call(read)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 55
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // both lines at 65: the soft one is off
  w.pct = 64
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 65
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 65% of the window \(the line is 65%\)/)
  w.pct = 30 // compacted some other way, unreported: a 35-point fall
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 50
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1) // once a session
  expect(floorMoves(w).map(e => e.floor)).toEqual([55])
})

test('a second cycle near the lines lifts them again, logged again, with no second toast', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 51
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 61%/)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.compacts.length).toBe(2)
  w.pct = 52
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1)
  expect(floorMoves(w).map(e => [e.floor, e.threshold])).toEqual([[51, 61], [52, 62]])
})

test("the floor after the mod's /compact (the desktop app's way) counts too, by hook or by the command's end", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 52, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'x' } as never) // landed, by the hook
  await clock.advance(1600)
  release()
  w.pct = 51
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 61%/)
  // the next one lands only by the command's end
  w.commandMode = 'done'
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await turnEnd($, 't2')
  await clock.advance(1500 * 3 + 100) // three refusals again, then /compact
  expect(w.commands.length).toBe(2)
  await clock.advance(1600)
  w.pct = 53
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600) // the log goes to disk on the timer
  expect(floorMoves(w).map(e => [e.floor, e.threshold])).toEqual([[51, 61], [53, 63]])
})

test('a /clear ends the floor: the next conversation in the same module starts with the lines as set', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  on('session.end', ($, e) => ({ sessionId: e.sessionId })) // nothing beneath answers it otherwise
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 51
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // lifted to 61
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: undefined } as never)
  w.pct = 55
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 55% of the window\. Compact at a comfortable moment before 60%/)
})

// 0.3.6: the handoff comes back in the continue prompt itself, and the one request after compact_now is answered by
// the mod. Before 0.3.6 the prompt only named the file and asked Claude to read it; in a 2026-10-18 benchmark Claude
// never did (0 of 10 compactions), so the handoff turns were pure cost.

const landed = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, turnId = 't1') => {
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })
  await clock.advance(1600) // the timer compacts
  await clock.advance(1600) // and sends the continue prompt
}

test('a note comes back word for word in the continue prompt, and a copy is saved in the state folder', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  const note = 'Task: tickets T01-T40.\nDone: T01-T09, tests green.\nNext: T10 (westbrook), then T11.'
  const q = await $.tool.call({ tool: TOOL, note, keep: 'the ticket list' } as never)
  expect(String(q.result)).toMatch(/Compaction queued\. End your reply now/)
  const saved = [...w.files].find(([p]) => /state\/catnap\/sess-1\.handoff\.md$/.test(slash(p)))
  expect(saved?.[1]).toBe(`${note}\n`)
  await landed($, clock)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0] ?? '').toMatch(/the ticket list/)
  expect(w.compacts[0] ?? '').toMatch(/gets its own handoff back, word for word/)
  expect(w.prompts.length).toBe(1)
  const p = w.prompts[0] ?? ''
  expect(p).toMatch(/^\[catnap\] The conversation was just compacted at your request \(context had reached 64%\)\. Here is the handoff you wrote just before it \(saved in .*sess-1\.handoff\.md\):/)
  expect(p).toContain(`<handoff>\n${note}\n</handoff>`)
  expect(p).toMatch(/Carry on exactly where you left off, with the next step it names\./)
  expect(p).not.toMatch(/Read it first/)
})

test("a handoff file comes back word for word (a save step's file), and nothing is written beside it", ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  w.files.set('C:/p/.claude/handoffs/x.md', 'RESUME - the mod build\nNext: step 3 of the plan\n')
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  expect([...w.files.keys()].some(k => /handoff\.md$/.test(k))).toBe(false)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toContain('Here is the handoff you wrote just before it (saved in C:/p/.claude/handoffs/x.md):')
  expect(p).toContain('<handoff>\nRESUME - the mod build\nNext: step 3 of the plan\n</handoff>')
  expect(w.compacts[0] ?? '').toMatch(/The full state is saved in C:\/p\/\.claude\/handoffs\/x\.md/)
})

test('a handoff file that cannot be read: the prompt names it and asks Claude to read it, as before', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/nowhere/h.md', keep: 'k' } as never)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toMatch(/Your handoff: C:\/nowhere\/h\.md\. Read it first, then carry on exactly where you left off/)
  expect(p).not.toContain('<handoff>')
})

test('a long handoff is cut at PASTE_MAX, and the prompt says where the rest is', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  w.files.set('C:/p/long.md', `${'a'.repeat(PASTE_MAX)}TAIL-NOT-PASTED`)
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/long.md', keep: 'k' } as never)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toContain(`[cut here at ${PASTE_MAX} characters: read the rest in C:/p/long.md before you go on]`)
  expect(p).not.toContain('TAIL-NOT-PASTED')
  expect(p.length).toBeLessThan(PASTE_MAX + 1000)
})

// The model beneath every turn.step: records the requests that reached it.
const model = (on: On) => {
  const calls: { turnId: string; index: number }[] = []
  on('turn.step', async function* ($, e) {
    calls.push({ turnId: e.turnId, index: e.index })
    yield { kind: 'text' as const, index: 0, text: 'from the model' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return calls
}

const step = async ($: Engine, turnId: string, index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 10 + index, ...(agentId ? { agentId } : {}) })
  const texts: string[] = []
  // read by hand to the end: the generator's own return value is the step's result as the engine gets it
  let r = await stream.next()
  while (!r.done) {
    if (r.value.kind === 'text') texts.push(r.value.text)
    r = await stream.next()
  }
  return { text: texts.join(''), result: r.value }
}

test('the request after compact_now is answered by the mod, once, in that turn only', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  expect((await step($, 't1', 0)).text).toBe('from the model') // nothing queued: the model answers
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  const nap = await step($, 't1', 1)
  expect(nap.text).toBe(NAP_REPLY)
  expect(nap.result.stopReason).toBe('end_turn')
  expect(nap.result.toolUses).toEqual([])
  expect(calls.length).toBe(1) // the request after compact_now never reached the model
  expect((await step($, 't1', 2)).text).toBe('from the model') // once only
  expect(calls.length).toBe(2)
  await clock.advance(1600)
})

test('the mod answers no request of a subagent, of another turn, or after the turn ended', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  expect((await step($, 't1', 1, 'agent-7')).text).toBe('from the model') // a subagent's request in that turn
  expect((await step($, 't9', 0)).text).toBe('from the model') // another turn
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  expect((await step($, 't1', 2)).text).toBe('from the model') // the turn is over
  expect(calls.length).toBe(3)
  await clock.advance(1600)
})

test('a compact_now denied (no handoff) leaves the next request to the model', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.tool.call({ tool: TOOL, keep: 'k' } as never)
  expect((await step($, 't1', 1)).text).toBe('from the model')
  expect(calls.length).toBe(1)
  await clock.advance(1600)
})

// The notes ask for compact_now in the same response as the last action (see the header in register.ts): a write and
// the test run beside it, with compact_now last as asked, or first.
for (const at of ['last', 'first'] as const)
  test(`compact_now beside other tools in one response (${at}): the next request is answered by the mod, and the nap runs`, ENGINE_SUMMARY, async ($, on) => {
    const { w, clock } = world(on, { pct: 64 })
    const calls = model(on)
    await start($)
    await $.turn.start({ text: 'go on', turnId: 't1' })
    expect((await step($, 't1', 0)).text).toBe('from the model')
    const napCall = () => $.tool.call({ tool: TOOL, note: 'the handoff', keep: 'k' } as never)
    if (at === 'first') expect((await napCall()).deny).toBeUndefined()
    const write = await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as never)
    const run = await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    if (at === 'last') expect((await napCall()).deny).toBeUndefined()
    expect(write.result).toBe('ok') // the other tools still ran
    expect(run.result).toBe('ok')
    if (at === 'first') expect((run.context ?? []).join('\n')).toMatch(/Compaction is queued/)
    const after = await step($, 't1', 1)
    expect(after.text).toBe(NAP_REPLY)
    expect(after.result.stopReason).toBe('end_turn')
    expect(calls.length).toBe(1) // the request after that response never reached the model
    await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: NAP_REPLY, durationMs: 1 })
    await clock.advance(1600)
    expect(w.compacts.length).toBe(1)
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0] ?? '').toMatch(/<handoff>\nthe handoff\n<\/handoff>/)
  })

// Below the line compact_now waits for the note unless the person asked (0.3.7). On a 1M window Claude napped on its
// own at 12-47% in 5 of 8 runs of a 2026-10-19 benchmark, while the lines say 50%.
const nap = ($: Engine) => $.tool.call({ tool: TOOL, note: 'the handoff', keep: 'k' } as never)
const tooEarly = (w: World) => logOf(w).filter(e => e.kind === 'too-early')

test("below the line compact_now on Claude's own is refused, logged, and nothing is compacted", async ($, on) => {
  const { w, clock } = world(on, { pct: 13 })
  await startQuiet($)
  const r = await nap($)
  expect(r.deny ?? '').toMatch(/^Not yet: context is at 13% of the window, below catnap's line \(50%\)\. Carry on with the work/)
  expect(r.deny ?? '').toMatch(/Don't call mcp__catnap__compact_now again before then, unless the person asks for a compaction\./)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(w.compacts).toEqual([])
  expect(w.prompts).toEqual([])
  expect(tooEarly(w).map(e => [e.percent, e.line])).toEqual([[13, 50]])
})

test('from the line on compact_now is taken with no ask', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 49 })
  await startQuiet($)
  expect((await nap($)).deny ?? '').toMatch(/^Not yet: context is at 49%/)
  w.pct = 50
  expect((await nap($)).deny).toBeUndefined()
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/context had reached 50%/)
})

test("the person's /catnap:compact lets one nap through below the line; after it the line holds again", ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 13 })
  await startQuiet($)
  await say($, '/catnap:compact keep the plan')
  expect((await nap($)).deny).toBeUndefined()
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1) // the continue
  w.pct = 6
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 14
  expect((await nap($)).deny ?? '').toMatch(/^Not yet: context is at 14%/)
})

test('words that ask for a compaction count, "catnap" alone does not, and each person prompt replaces the last', async ($, on) => {
  const { w } = world(on, { pct: 13 })
  await startQuiet($)
  await say($, 'is catnap on?')
  expect((await nap($)).deny ?? '').toMatch(/^Not yet/)
  await say($, 'please compact now')
  await say($, 'actually, carry on')
  expect((await nap($)).deny ?? '').toMatch(/^Not yet/)
  await say($, 'take a nap here')
  expect((await nap($)).deny).toBeUndefined()
  expect(w.compacts).toEqual([])
})

test("catnap's own prompts and notifications are not the person asking, and leave an ask standing", async ($, on) => {
  const { w } = world(on, { pct: 13 })
  await startQuiet($)
  await say($, '[catnap] The conversation was just compacted at your request (context had reached 61%).', 'plugin')
  expect((await nap($)).deny ?? '').toMatch(/^Not yet/)
  await say($, '/catnap:compact')
  await say($, 'Background task done: compact the logs', 'task-notification')
  await say($, '[catnap] Your last turn ended with context at 63% of the window', 'plugin')
  expect((await nap($)).deny).toBeUndefined()
  expect(w.prompts.length).toBe(3) // those three reached the session; the person's own prompt is not counted there
})

test("the SDK host's prompt (a desktop app chat, claude -p) is the person's", async ($, on) => {
  world(on, { pct: 13 })
  await startQuiet($)
  await say($, '/catnap:compact', 'sdk')
  expect((await nap($)).deny).toBeUndefined()
})

test('with the soft line off the strict line holds; after a compaction that freed little, the lifted line holds', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 55 })
  w.files.set('X/state/catnap/config.json', '{"soft": 70, "threshold": 60}') // a soft line above the strict one is off
  await startQuiet($)
  expect((await nap($)).deny ?? '').toMatch(/^Not yet: context is at 55% of the window, below catnap's line \(60%\)/)
  w.pct = 60
  expect((await nap($)).deny).toBeUndefined()
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 58 // the compaction freed almost nothing: the line moves to 68 for this cycle
  await $.tool.call(read)
  w.pct = 64
  expect((await nap($)).deny ?? '').toMatch(/^Not yet: context is at 64% of the window, below catnap's line \(68%\)/)
  w.pct = 68
  expect((await nap($)).deny).toBeUndefined()
})

test('off in config.json, or a session where nothing draws, never holds compact_now', async ($, on) => {
  const { w } = world(on, { pct: 13 })
  w.files.set('X/state/catnap/config.json', '{"off": true}')
  await startQuiet($)
  expect((await nap($)).deny).toBeUndefined()
})

test('a plain -p run (nothing draws, not a desktop chat) never holds compact_now', async ($, on) => {
  world(on, { pct: 13, surfaces: [] })
  await startQuiet($)
  expect((await nap($)).deny).toBeUndefined()
})

test('the tool says when to use it', async ($, on) => {
  const { w } = world(on)
  await startQuiet($)
  expect(w.descriptions.join('\n')).toMatch(
    /Use it when a \[catnap\] note asks you to, or when the person asks for a compaction; before that, carry on: the window has room, and the note tells you when\./,
  )
  expect(w.descriptions.join('\n')).toMatch(
    /no separate file is needed\. Make that call in the same response as your last action \(for example the command that runs the tests\), as its last tool call, not in a reply of its own: a reply of its own reads the whole conversation once more\. You will not see that action's result before the compaction, so your handoff's next step starts with checking it\. After calling it, end your reply at once/,
  )
})

test('asksToCompact: what counts as asking', () => {
  for (const yes of ['/catnap:compact', '/compact', 'compact now', 'Compacting is fine', 'take a nap', 'NAP now'])
    expect(asksToCompact(yes)).toBe(true)
  for (const no of ['', 'is catnap on?', 'carry on', 'snap a photo', 'napkin math', 'catnap'])
    expect(asksToCompact(no)).toBe(false)
})

// Fresh start (config.json "fresh": true): after compact_now the mod clears the conversation instead of compacting it,
// and the handoff opens the new one. No compaction call, and no summary in the context from then on.

const FRESH = 'X/state/catnap/config.json'

test('fresh start: the nap clears the conversation instead of compacting it, and the handoff opens the new one', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  w.files.set(FRESH, '{"fresh": true}')
  await start($)
  const note = 'Task: tickets T01-T40.\nDone: T01-T09, tests green.\nNext: T10 (westbrook), then T11.'
  await $.tool.call({ tool: TOOL, note, keep: 'the ticket list' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600) // the timer runs /clear
  expect(w.commands).toEqual(['/clear '])
  expect(w.compacts).toEqual([])
  await clock.advance(1600) // and opens the new conversation
  expect(w.prompts.length).toBe(1)
  const p = w.prompts[0] ?? ''
  expect(p).toMatch(/^\[catnap\] This is a fresh start: the conversation was cleared at your request \(context had reached 64%\), so you have only your handoff\. Here is the handoff you wrote just before it/)
  expect(p).toContain(`<handoff>\n${note}\n</handoff>`)
  expect(p).toMatch(/Carry on exactly where you left off, with the next step it names\./)
  expect(p).not.toMatch(/compacted/)
})

test("fresh start: the clear's session end lands it; the command's later end sends nothing more", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold' })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  w.files.set(FRESH, '{"fresh": true}')
  await start($)
  await $.tool.call({ tool: TOOL, note: 'Next: T10.', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.commands).toEqual(['/clear '])
  await clock.advance(1600)
  expect(w.prompts).toEqual([]) // the clear has not happened yet
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: undefined } as never)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toContain('<handoff>\nNext: T10.\n</handoff>')
  release()
  await clock.advance(1600)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.commands.length).toBe(1)
})

test('a /clear typed with nothing queued sends no continue prompt, also with fresh start on', async ($, on) => {
  const { w, clock } = world(on, { pct: 30 })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  w.files.set(FRESH, '{"fresh": true}')
  await start($)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: undefined } as never)
  await clock.advance(1600)
  await clock.advance(1600)
  expect(w.prompts).toEqual([])
  expect(w.commands).toEqual([])
})

test('fresh start: a refused /clear gives up for the cycle with a toast, and nothing is compacted', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'refuse' })
  w.files.set(FRESH, '{"fresh": true}')
  await start($)
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  await clock.advance(1600)
  expect(w.commands).toEqual(['/clear '])
  expect(w.compacts).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts.some(t => /\/clear was refused/.test(t))).toBe(true)
})

test('with fresh start off (the default), the nap compacts as before', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  await clock.advance(1600)
  expect(w.commands).toEqual([])
  expect(w.compacts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
})

// Handoff in place of the summary (on by default since 0.3.9; the option handoff_summary or config.json
// "handoffSummary": false turns it off): catnap compacts through /compact, and its session.compact hook answers that
// compaction with the handoff and the person's prompts, so nothing reaches the engine's summarizer; the continue prompt
// only says the handoff is above. The tests above marked ENGINE_SUMMARY run with it off, and there the engine compacts.

type Compacted = { messages?: { role: string; text: string; toolUses: unknown[] }[]; skip?: string }
const OWN_CONTINUE =
  '[catnap] The conversation was just compacted at your request (context had reached 64%). Your handoff is above, in place of a summary. ' +
  'Carry on exactly where you left off, with the next step it names. ' +
  'If you napped in the same response as your last action, the person has not had your reply on that step yet: once you have checked its result, give them that reply as you would have. ' +
  'If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work.'

// The nap with the option on: compact_now, the turn ends, the timer runs /compact (held, as a real one runs).
const ownNap = async ($: Engine, w: World, clock: { advance: (ms: number) => Promise<void> }, note: string, turnId = 't1') => {
  await $.tool.call({ tool: TOOL, note, keep: 'k' } as never)
  await turnEnd($, turnId)
  await clock.advance(1600)
}
// /compact compacts: the engine raises session.compact with trigger manual
const engineCompacts = async ($: Engine, extra: Record<string, unknown> = {}) =>
  (await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'x', ...extra } as never)) as Compacted

test("handoff summary (the default): catnap's /compact is answered with the handoff and the person's prompts, word for word", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold' }) // no option, no config file: the default
  await startQuiet($)
  await say($, 'Build the ticket parser; keep the CLI flags as they are.', 'sdk')
  await say($, 'Also: T07 is blocked, skip it.')
  await say($, 'a reminder from a plugin', 'plugin') // not the person's
  await say($, '/catnap:compact')
  w.prompts.splice(0) // the bottom records the plugin's prompt above
  await ownNap($, w, clock, 'Task: the parser.\nNext: T08.')
  expect(w.triggers).toEqual([]) // no direct call: straight to /compact
  expect(w.commands.length).toBe(1)
  expect(w.commands[0] ?? '').toMatch(/^\/compact Keep what the next turn needs to continue: k\./)
  const r = await engineCompacts($)
  expect(w.triggers).toEqual(['manual']) // only the stand-in reached the engine (the PreCompact hooks, 0.3.12)
  expect(w.compacts).toEqual([])
  expect(r.messages?.length).toBe(1)
  expect(r.messages?.[0]?.role).toBe('user')
  expect(r.messages?.[0]?.toolUses).toEqual([])
  const text = r.messages?.[0]?.text ?? ''
  expect(text).toMatch(
    /^\[catnap\] This conversation was compacted at your request \(context had reached 64%\)\. In place of a summary, here is the handoff you wrote just before it \(saved in .*sess-1\.handoff\.md\):\n\n<handoff>\nTask: the parser\.\nNext: T08\.\n<\/handoff>\n\n/,
  )
  expect(text).toContain(
    "The person's messages in this session, word for word (the latest last):\n\n" +
      '<message>\nBuild the ticket parser; keep the CLI flags as they are.\n</message>\n' +
      '<message>\nAlso: T07 is blocked, skip it.\n</message>\n' +
      '<message>\n/catnap:compact\n</message>',
  )
  expect(text).not.toContain('a reminder from a plugin')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE]) // the handoff is not pasted a second time
  release() // the command finishes after its compaction: no second continue
  await clock.advance(3200)
  expect(w.prompts).toEqual([OWN_CONTINUE])
  expect(logOf(w).filter(e => e.kind === 'compacted').map(e => [e.via, e.own])).toEqual([['prompt', true]])
  // the next nap goes the same way, and the person's prompts are still there
  w.pct = 5
  await $.tool.call(read)
  w.pct = 64
  await ownNap($, w, clock, 'Next: T09.', 't2')
  release()
  const again = (await engineCompacts($)).messages?.[0]?.text ?? ''
  expect(again).toContain('<handoff>\nNext: T09.\n</handoff>')
  expect(again).toContain('<message>\nAlso: T07 is blocked, skip it.\n</message>')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE, OWN_CONTINUE])
  expect(w.compacts).toEqual([])
})

test('handoff summary: where direct compaction is refused (the desktop app) it goes the same way', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  expect(w.triggers).toEqual([]) // no direct call to be refused
  expect(w.commands.length).toBe(1)
  expect((await engineCompacts($)).messages?.[0]?.text ?? '').toContain('<handoff>\nNext: T08.\n</handoff>')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
})

test('handoff summary: where the hook never sees the compaction, the finished /compact lands it and the continue prompt carries the handoff', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 }) // commandMode done: the command ends with no session.compact seen
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  await clock.advance(1600)
  expect(w.commands.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/^\[catnap\] The conversation was just compacted at your request \(context had reached 64%\)\. Here is the handoff you wrote just before it/)
  expect(w.prompts[0] ?? '').toContain('<handoff>\nNext: T08.\n</handoff>')
})

test("handoff summary: while catnap's /compact is out, a subagent's compaction and an auto-compact go to the engine", async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  expect((await engineCompacts($, { agentId: 'a1', instructions: undefined })).messages?.[0]?.text).toBe('summary')
  expect((await engineCompacts($, { trigger: 'auto', instructions: undefined })).messages?.[0]?.text).toBe('summary')
  expect(w.triggers).toEqual(['manual', 'auto'])
})

test('handoff summary: a compaction catnap did not run (a typed /compact, auto-compact, ahead of time, another plugin) goes to the engine', async ($, on) => {
  const { w } = world(on, { pct: 64 })
  await start($)
  for (const trigger of ['manual', 'auto', 'precompute', 'plugin'] as const)
    expect((await engineCompacts($, { trigger, instructions: undefined })).messages?.[0]?.text).toBe('summary')
  expect(w.triggers).toEqual(['manual', 'auto', 'precompute', 'plugin'])
  expect(w.prompts).toEqual([])
})

test("handoff summary: a save step's handoff file stands in the summary's place, word for word, and nothing is written beside it", { options: { save_step: '/save-before-compact' } }, async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold' })
  w.files.set('C:/p/.claude/handoffs/x.md', 'RESUME - the mod build\nNext: step 3 of the plan\n')
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.commands.length).toBe(1)
  expect([...w.files.keys()].some(k => /handoff\.md$/.test(k))).toBe(false)
  const text = (await engineCompacts($)).messages?.[0]?.text ?? ''
  expect(text).toContain(
    'here is the handoff you wrote just before it (saved in C:/p/.claude/handoffs/x.md):\n\n<handoff>\nRESUME - the mod build\nNext: step 3 of the plan\n</handoff>',
  )
  expect(w.triggers).toEqual(['manual']) // the stand-in only
  expect(w.compacts).toEqual([])
  await clock.advance(1600)
  release()
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
})

test('handoff summary: a handoff file that cannot be read leaves the compaction to the engine', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/gone.md', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect((await engineCompacts($)).messages?.[0]?.text).toBe('summary')
  expect(w.triggers).toEqual(['manual'])
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your handoff: C:\/p\/\.claude\/handoffs\/gone\.md\. Read it first/)
})

// 0.3.12: a nap runs the person's PreCompact hooks (a transcript backup, say). Core runs them beneath next(), so while
// catnap answered its own /compact with the handoff and never called next(), every nap skipped them. catnap now hands
// core a one-message stand-in first: the hooks run, core refuses one message with no model call, and the handoff stands.
const preCompactLog = (w: World) => logOf(w).filter(e => e.kind === 'pre-compact').map(e => e.outcome)

test("handoff summary: a nap runs the person's PreCompact hooks once, with no summary, and the handoff still stands", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  const r = await engineCompacts($)
  expect(w.preCompacts).toEqual(['manual'])
  expect(w.compacts).toEqual([]) // the summarizer never ran
  expect(r.skip).toBeUndefined()
  expect(r.messages?.length).toBe(1)
  expect(r.messages?.[0]?.text ?? '').toContain('<handoff>\nNext: T08.\n</handoff>')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
  release()
  await clock.advance(3200)
  expect(w.prompts).toEqual([OWN_CONTINUE])
  expect(preCompactLog(w)).toEqual(['ran'])
  expect(w.toasts).toEqual([])
})

test('handoff summary: a PreCompact hook that blocks the nap is honoured: no handoff, the skip as core wrote it, no continue prompt', async ($, on) => {
  const block = 'Compaction blocked by PreCompact hook: [./backup.sh]: disk full'
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold', preCompactBlock: block })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  const r = await engineCompacts($)
  expect(r.skip).toBe(block)
  expect(r.messages).toBeUndefined()
  expect(w.preCompacts).toEqual(['manual'])
  expect(w.compacts).toEqual([])
  release() // the /compact finishes after its compaction was skipped: nothing lands
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect(w.toasts.join('\n')).toContain(`the compaction was skipped (${block})`)
  expect(logOf(w).filter(e => e.kind === 'skipped').map(e => [e.via, e.reason])).toEqual([['prompt', block]])
  expect(logOf(w).some(e => e.kind === 'compacted')).toBe(false)
  expect(preCompactLog(w)).toEqual(['blocked'])
  // once the hook lets compactions through, the next nap lands as usual
  w.preCompactBlock = null
  await ownNap($, w, clock, 'Next: T09.', 't2')
  expect((await engineCompacts($)).messages?.[0]?.text ?? '').toContain('<handoff>\nNext: T09.\n</handoff>')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
})

test('handoff summary: an engine that summarizes the one-message stand-in: its summary is dropped and the handoff stands', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold', oneSummarized: true })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  const r = await engineCompacts($)
  expect(w.preCompacts).toEqual(['manual'])
  expect(w.compacts.length).toBe(1) // one small model call, and it shows in the log
  expect(r.messages?.length).toBe(1)
  expect(r.messages?.[0]?.text ?? '').toContain('<handoff>\nNext: T08.\n</handoff>')
  expect(r.messages?.[0]?.text ?? '').not.toBe('summary')
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
  expect(preCompactLog(w)).toEqual(['summarized'])
})

test('handoff summary: the stand-in carries the /compact instructions and one message, whatever the conversation held', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  await engineCompacts($, { instructions: 'Keep the parser work.' })
  expect(w.reached).toEqual([{ trigger: 'manual', instructions: 'Keep the parser work.', n: 1 }])
})

// 0.3.12: a model that puts the handoff itself in the handoff field (a path field): live, Haiku 5.5 did it in 2 of 6
// naps on 2026-10-22, and the nap then went to the engine's summary with a continue prompt asking to read a "file"
// named by the text. Text that cannot be read and does not look like a file path goes as the note.
test('handoff summary: the handoff written into the handoff field (not a path) goes as the note, in place of the summary', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  const text = 'Task so far: the user asked me to remember the code word PELICAN-7. Next: wait for the next message.'
  await $.tool.call({ tool: TOOL, handoff: text, keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  const r = await engineCompacts($)
  expect(r.messages?.[0]?.text ?? '').toContain(`<handoff>\n${text}\n</handoff>`)
  expect(w.compacts).toEqual([])
  await clock.advance(1600)
  expect(w.prompts).toEqual([OWN_CONTINUE])
  expect(logOf(w).some(e => e.kind === 'compacted' && e.own === true)).toBe(true) // the log is written on the timer
})

test('handoff summary: a readable file in the handoff field is read as a file, whatever its name', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  w.files.set('C:/p/HANDOFF', 'Next: T08.\n')
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/HANDOFF', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1600)
  const text = (await engineCompacts($)).messages?.[0]?.text ?? ''
  expect(text).toContain('(saved in C:/p/HANDOFF):\n\n<handoff>\nNext: T08.\n</handoff>')
})

test('a path in the handoff field stays a path: a readable file of any name, and an unreadable one that looks like a path', () => {
  expect(proseHandoff('Task so far: the parser. Next: T08.')).toBe(true)
  expect(proseHandoff('Next: T08.\nOpen: none')).toBe(true) // more than one line
  expect(proseHandoff('notes.md\nplan.md')).toBe(true) // two lines, each like a file name
  expect(proseHandoff('All done, nothing next')).toBe(true) // short, no file extension
  expect(proseHandoff('done; next is the handoff in register.ts and the tests in catnap.test.ts')).toBe(true) // many words
  expect(proseHandoff('x'.repeat(401) + '.md')).toBe(true)
  expect(proseHandoff('C:/p/.claude/handoffs/x.md')).toBe(false)
  expect(proseHandoff('C:\\Users\\John Smith\\My Notes\\handoff.md')).toBe(false)
  expect(proseHandoff('.claude/handoffs/catnap-precompact.md')).toBe(false)
  expect(proseHandoff('RESUME.md')).toBe(false)
})

test("handoff summary: the person's prompts kept are the newest, each cut, up to the cap; the option and config key", () => {
  expect(keepSaid([])).toEqual([])
  expect(keepSaid(['a', 'b'])).toEqual(['a', 'b'])
  expect(keepSaid(['x'.repeat(PERSON_EACH + 50)])).toEqual([`${'x'.repeat(PERSON_EACH)} [cut]`])
  const k = 'y'.repeat(PERSON_EACH)
  expect(keepSaid(['first', k, k, k, 'last'])).toEqual(['first', k, k, k, 'last']) // 12,009 characters: all kept
  const many = Array<string>(13).fill(k)
  expect(keepSaid(['first', ...many, 'last'])).toEqual([...Array<string>(11).fill(k), 'last']) // a twelfth k would pass 48,000
  expect(fromOptions(undefined).base.handoffSummary).toBe(true) // on by default
  expect(fromOptions({ handoff_summary: true } as never).base.handoffSummary).toBe(true)
  expect(fromOptions({ handoff_summary: false } as never).base.handoffSummary).toBe(false)
  expect(parseConfig([]).handoffSummary).toBe(true)
  expect(parseConfig(['{"handoffSummary": false}']).handoffSummary).toBe(false)
  expect(parseConfig(['{"handoffSummary": "no"}']).handoffSummary).toBe(true) // not a boolean: the default stands
  expect(parseConfig(['{"handoffSummary": false}'], fromOptions({ handoff_summary: true } as never).base).handoffSummary).toBe(false)
  expect(parseConfig(['{"handoffSummary": true}'], fromOptions({ handoff_summary: false } as never).base).handoffSummary).toBe(true)
})

test("handoff summary off (the option): catnap's /compact goes to the engine, and the continue prompt carries the handoff", ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await $.tool.call({ tool: TOOL, note: 'Next: T08.', keep: 'k' } as never)
  await turnEnd($, 't1')
  await clock.advance(1500 * 3 + 100) // three refusals: /compact
  expect(w.commands.length).toBe(1)
  expect((await engineCompacts($)).messages?.[0]?.text).toBe('summary')
  expect(w.triggers.filter(t => t !== undefined)).toEqual(['manual'])
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toContain('<handoff>\nNext: T08.\n</handoff>')
})

test('handoff summary turned off between naps: the next nap is compacted by the engine, with the full continue prompt', async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  await engineCompacts($)
  await clock.advance(1600)
  release()
  expect(w.prompts).toEqual([OWN_CONTINUE])
  w.files.set(FRESH, '{"handoffSummary": false}')
  w.pct = 5
  await $.tool.call(read)
  w.pct = 64
  await $.tool.call({ tool: TOOL, note: 'Next: T09.', keep: 'k' } as never)
  await landed($, clock, 't2')
  expect(w.compacts.length).toBe(1) // the direct call, as before the option
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1] ?? '').toContain('<handoff>\nNext: T09.\n</handoff>')
})

test('handoff summary: its compaction sets the floor like any other', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  await engineCompacts($)
  await clock.advance(1600)
  w.pct = 58 // the compaction freed almost nothing: the lines move to 68 for this cycle
  await $.tool.call(read)
  w.pct = 64
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 68
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

// The skills the conversation used come back in the summary as they were loaded (the engine's own compaction adds
// them back too): catnap keeps each skill's text from skill.prompt, and carries the ones the main conversation used.
const loadSkill = ($: Engine, skill: string, text: string, pluginName?: string) =>
  $.skill.prompt({ skill, text, frontmatter: {}, source: pluginName ? 'plugin' : 'userSettings', pluginName } as never)
const typed = (name: string) => ({ role: 'user' as const, text: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`, toolUses: [] })
const viaTool = (name: string) => ({
  role: 'assistant' as const,
  text: '',
  toolUses: [{ tool_use_id: `t-${name}`, tool: 'Skill', input: { skill: name } }],
})

test('handoff summary: the skills the conversation used come back as they were loaded; its own commands and a skill it never used do not', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await loadSkill($, 'operating-rules', 'RULES: at most 10 agents at once.')
  await loadSkill($, 'review', 'Review the diff line by line.')
  await loadSkill($, 'catnap:compact', 'Compact this conversation now.', 'catnap')
  await loadSkill($, 'subagent-only', 'A subagent loaded this.')
  await ownNap($, w, clock, 'Next: T08.')
  const messages = [typed('operating-rules'), viaTool('review'), typed('catnap:compact'), typed('compact'), ...MSGS]
  const text = (await engineCompacts($, { messages })).messages?.[0]?.text ?? ''
  expect(text).toContain(
    '\n\nSkills used earlier in this session, as they were loaded: keep following their standing rules where they still apply, and do not redo their one-time steps.\n\n' +
      '<skill name="operating-rules">\nRULES: at most 10 agents at once.\n</skill>\n<skill name="review">\nReview the diff line by line.\n</skill>',
  )
  expect(text).not.toContain('Compact this conversation now.')
  expect(text).not.toContain('A subagent loaded this.')
  expect(text).not.toContain('<skill name="compact">') // a built-in command loads no skill text
  // the next nap carries them again: catnap's summary is now where the conversation names them
  await clock.advance(1600)
  w.pct = 5
  await $.tool.call(read)
  w.pct = 64
  await ownNap($, w, clock, 'Next: T09.', 't2')
  const again = (await engineCompacts($, { messages: [{ role: 'user', text, toolUses: [] }, ...MSGS] })).messages?.[0]?.text ?? ''
  expect(again).toContain('<skill name="operating-rules">\nRULES: at most 10 agents at once.\n</skill>')
  expect(again).toContain('<skill name="review">\nReview the diff line by line.\n</skill>')
})

test('handoff summary: with no skill used, the summary has no skills part', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await loadSkill($, 'review', 'Review the diff line by line.')
  await ownNap($, w, clock, 'Next: T08.')
  const text = (await engineCompacts($)).messages?.[0]?.text ?? ''
  expect(text).not.toMatch(/Skills used earlier|<skill /)
})

const viaSearch = (query: string) => ({
  role: 'assistant' as const,
  text: '',
  toolUses: [{ tool_use_id: `t-${query}`, tool: 'ToolSearch', input: { query, max_results: 5 } }],
})

test('handoff summary: tools loaded with ToolSearch select: are named for loading again, at this nap and the next', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  const messages = [viaSearch('select:TaskCreate,TaskUpdate'), viaSearch('notebook jupyter'), viaSearch('select: Monitor , TaskCreate'), ...MSGS]
  const text = (await engineCompacts($, { messages })).messages?.[0]?.text ?? ''
  const line =
    '\n\nTools you loaded with ToolSearch before this compaction are unloaded now, and a call to one of them fails until it is loaded again. ' +
    'Before you call any of them, load them with one call: ToolSearch with query "select:TaskCreate,TaskUpdate,Monitor".'
  expect(text).toContain(line)
  expect(text).not.toContain('jupyter') // a keyword search names no tool
  await clock.advance(1600)
  w.pct = 5
  await $.tool.call(read)
  w.pct = 64
  await ownNap($, w, clock, 'Next: T09.', 't2')
  const again = (await engineCompacts($, { messages: [{ role: 'user', text, toolUses: [] }, ...MSGS] })).messages?.[0]?.text ?? ''
  expect(again).toContain(line)
})

test('handoff summary: with no tool loaded, the summary has no tools part', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, commandMode: 'hold' })
  await start($)
  await ownNap($, w, clock, 'Next: T08.')
  const text = (await engineCompacts($)).messages?.[0]?.text ?? ''
  expect(text).not.toContain('ToolSearch')
})

test('handoff summary: skillsIn and keepSkills: names from the conversation; the newest texts, each cut, up to the cap', () => {
  expect([...skillsIn([])]).toEqual([])
  expect([...skillsIn([typed('a'), viaTool('b'), { text: 'x <skill name="c">\ny\n</skill>', toolUses: [] }])]).toEqual(['a', 'b', 'c'])
  expect(keepSkills(new Map(), new Set(['a']))).toEqual([])
  const loaded = new Map([['old', 'o'], ['a', 'A'], ['unused', 'U'], ['b', 'B']])
  expect(keepSkills(loaded, new Set(['a', 'b', 'old', 'never-loaded']))).toEqual([['old', 'o'], ['a', 'A'], ['b', 'B']])
  const long = 'x'.repeat(SKILL_EACH + 10)
  expect(keepSkills(new Map([['big', long]]), new Set(['big']))).toEqual([['big', `${'x'.repeat(SKILL_EACH)}\n[cut here: load the skill again for the rest]`]])
  const k = 'y'.repeat(SKILL_EACH - 100)
  const many = new Map([['s1', k], ['s2', k], ['s3', k], ['s4', k]])
  const kept = keepSkills(many, new Set(['s1', 's2', 's3', 's4']))
  expect(kept.map(([n]) => n)).toEqual(['s2', 's3', 's4']) // a fourth would pass SKILL_MAX
  expect(kept.reduce((n, [, t]) => n + t.length, 0)).toBeLessThanOrEqual(SKILL_MAX)
})

// The token lines (0.3.11): each line also has a size in tokens, and whichever comes first counts. On a 1M window the
// defaults put the lines at 300K, 400K and 500K (30, 40 and 50%); on 200K the percent lines come first, as in every test
// above.
const M1 = { window: 1_000_000 }

test('token lines: on a 1M window the soft note comes at 300K, the strict one at 400K, auto-compact at 500K', async ($, on) => {
  const { w, clock, vars } = world(on, { ...M1, pct: 29 })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('50')
  w.pct = 30
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 30% of the window\. Compact at a comfortable moment before 40%/)
  w.pct = 39
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 40
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 40% of the window \(the line is 40%\)\. Save and compact now/)
  await clock.advance(1600)
  expect(w.toasts).toEqual([]) // auto (50) sits above the strict line (40)
})

test('token lines: on 1M the auto line is 50 from the start, before any tool call', async ($, on) => {
  const { clock, vars } = world(on, M1)
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('50')
})

test('token lines: on 1M a turn that ends past 400K gets the ask; one that ends below it does not', async ($, on) => {
  const { w, clock } = world(on, { ...M1, pct: 39 })
  await start($)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.prompts).toEqual([])
  w.pct = 41
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your last turn ended with context at 41% of the window \(the line is 40%\)/)
})

test('token lines: on 1M compact_now waits for 300K, not 50%', ENGINE_SUMMARY, async ($, on) => {
  const { w } = world(on, { ...M1, pct: 29 })
  await startQuiet($)
  expect((await nap($)).deny ?? '').toMatch(/^Not yet: context is at 29% of the window, below catnap's line \(30%\)/)
  w.pct = 30
  expect((await nap($)).deny).toBeUndefined()
})

test(
  'token lines: a percent line that comes first still counts',
  { options: { soft_percent: 20, strict_percent: 35, auto_percent: 45 } },
  async ($, on) => {
    const { w, clock, vars } = world(on, { ...M1, pct: 20 })
    await start($)
    expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 20% of the window\. Compact at a comfortable moment before 35%/)
    await clock.advance(1600)
    expect(vars.get(AUTO)).toBe('45')
    w.pct = 35
    expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/\(the line is 35%\)\. Save and compact now/)
  },
)

test(
  'token lines: soft_tokens moves the soft line; strict_tokens and auto_tokens 0 leave the percent lines',
  { options: { soft_tokens: 200_000, strict_tokens: 0, auto_tokens: 0 } },
  async ($, on) => {
    const { w, clock, vars } = world(on, { ...M1, pct: 19 })
    await start($)
    expect((await $.tool.call(read)).context ?? []).toEqual([])
    await clock.advance(1600)
    expect(vars.get(AUTO)).toBe('70')
    w.pct = 20
    expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 20% of the window\. Compact at a comfortable moment before 60%/)
    w.pct = 59
    expect((await $.tool.call(read)).context ?? []).toEqual([])
    w.pct = 60
    expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/\(the line is 60%\)\. Save and compact now/)
  },
)

test('token lines: config.json wins over the options and is re-read at each check', async ($, on) => {
  const { w, clock, vars } = world(on, { ...M1, pct: 31 })
  w.files.set('X/state/catnap/config.json', '{"softTokens": 0, "thresholdTokens": 0, "autoTokens": 0}')
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // 50% is the soft line again
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  w.files.set('X/state/catnap/config.json', '{"softTokens": 250000, "autoTokens": 450000}')
  w.pct = 32
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 32% of the window\. Compact at a comfortable moment before 40%/)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('45')
})

test('token lines: a switch to a 200K model moves them back to the percent lines at the next check', async ($, on) => {
  const { w, clock, vars } = world(on, { ...M1, pct: 10 })
  await start($)
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('50')
  w.window = 200_000
  w.pct = 35
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // 30% is no line on 200K
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  w.pct = 50
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
})

test('token lines: the floor guard lifts the token lines like the percent ones', ENGINE_SUMMARY, async ($, on) => {
  const { w, clock } = world(on, { ...M1, pct: 41 })
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 25 // a heavy fixed part: 250K right after compacting
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(w.toasts[0] ?? '').toMatch(/still at 25% right after compacting.*the next note waits for 35%/)
  w.pct = 34
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 35
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 35% of the window\. Compact at a comfortable moment before 40%/)
  expect(floorMoves(w).map(e => [e.floor, e.soft, e.threshold])).toEqual([[25, 35, 40]])
})

test("token lines: auto_percent 0 still leaves Claude Code's own setting alone on 1M", { options: { auto_percent: 0 } }, async ($, on) => {
  const { clock, vars } = world(on, { ...M1, pct: 30 }, { ...HOME, [AUTO]: '55' })
  await start($)
  await $.tool.call(read)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('55')
  expect(vars.has(ORIG)).toBe(false)
})

test('token lines: capped, fromOptions and parseConfig', () => {
  const d = fromOptions(undefined).base
  expect([d.softTokens, d.thresholdTokens, d.autoTokens]).toEqual([300_000, 400_000, 500_000])
  const on1m = capped(d, 1_000_000)
  expect([on1m.soft, on1m.threshold, on1m.auto]).toEqual([30, 40, 50])
  const on200k = capped(d, 200_000)
  expect([on200k.soft, on200k.threshold, on200k.auto]).toEqual([50, 60, 70])
  expect(capped(d, undefined)).toEqual(d) // no window size: the percent lines
  expect(capped(d, 0)).toEqual(d)
  expect(capped({ ...d, softTokens: 333_333 }, 1_000_000).soft).toBe(33) // rounded down to whole percent
  expect(capped({ ...d, softTokens: 1 }, 1_000_000).soft).toBe(1) // at least 1
  expect(capped({ ...d, auto: 0 }, 1_000_000).auto).toBe(0) // 0 still means "leave it alone"
  const o = fromOptions({ soft_tokens: '250000', strict_tokens: 0, auto_tokens: -5 } as never).base
  expect([o.softTokens, o.thresholdTokens, o.autoTokens]).toEqual([250_000, 0, 500_000])
  const c = parseConfig(['{"softTokens": 0, "thresholdTokens": "x", "autoTokens": 450000}'], d)
  expect([c.softTokens, c.thresholdTokens, c.autoTokens]).toEqual([0, 400_000, 450_000])
  expect(parseConfig(['{"softTokens": -1}']).softTokens).toBe(300_000)
})
