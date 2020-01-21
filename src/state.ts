import Vue from "vue"
import { openDB, IDBPDatabase } from "idb"
import { Move, Board, Game } from "./game"

export enum EventType {
  Normal = 0,
  Fmc = 1,
  Blind = 2
}

export interface Solve {
  time: number
  moves: Move[]
  scramble: Board
  startTime: number
  memoTime?: number
  dnf?: boolean
}

export interface StoredState {
  version: number
  cols: number
  rows: number
  event: EventType
  noRegrips?: boolean
  darkMode?: boolean
  forceMobile?: boolean
  useLetters?: boolean
  darkText?: boolean
}

export class State {
  cols = 5
  rows = 5
  custom = false
  event = EventType.Normal
  noRegrips = false

  darkMode = false
  forceMobile = false
  useLetters = true
  darkText = false

  /** Timer is running */
  started = false
  /** Is a generated scramble */
  scrambled = false
  inSolvingPhase = false
  dnf = false

  time = 0
  startTime = 0
  memoTime = 0
  interval?: any

  scrambledBoard?: Board
  moveHistory: Move[] = []
  undos = 0
  inspecting = false

  solves: Solve[] = []
  allSolves: Solve[] = []
  sessionSolves: { [event: string]: Solve[] } = {}

  db?: IDBPDatabase
  sessionId?: number

  game!: Game

  get eventName() {
    return `${state.cols}x${state.rows}`
      + ["", "-fmc", "-bld"][state.event]
      + (state.noRegrips ? "-nrg" : "")
  }

  get displayTime() {
    if (this.inspecting) {
      return this.moveHistory[this.moveHistory.length - this.undos]?.time ?? this.time
    } else {
      return this.time
    }
  }

  get moves() {
    return this.moveHistory.length - this.undos
  }

  get showUndoRedo() {
    return this.event == EventType.Fmc || this.inspecting
  }

  get undoable() {
    return this.undos == this.moveHistory.length
  }

  get redoable() {
    return this.undos == 0
  }

  formatTime(ms?: number | null, compact = false) {
    if (ms == null) return "―"
    const s = ms / 1000
    const min = (s / 60) | 0, sec = s % 60 | 0, millis = ms % 1000 | 0
    if (compact) {
      return `${min > 0 ? `${min}:` : ""}${(s % 60).toPrecision(3)}`
    } else {
      return `${min}:${sec.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`
    }
  }

  async getSolvesByEvent(): Promise<{ [event: string]: Solve[] }> {
    if (!this.db) return {}
    const solves: { event: string, solve: Solve }[] = await this.db?.getAll("solves")

    return solves.reduce<{ [event: string]: Solve[] }>((solves, { event, solve }) => {
      (solves[event] = solves[event] ?? []).push(solve)
      return solves
    }, {})
  }

  start() {
    this.started = true

    this.time = 0
    this.memoTime = 0
    this.startTime = Date.now()

    this.interval = setInterval(() => {
      this.time = Date.now() - this.startTime
    }, 87)
  }

  scramble() {
    this.reset(true)
    this.game.scramble()
    this.game.canvas.focus()

    this.scrambled = true
    this.scrambledBoard = this.game.board.clone()

    if (this.event == EventType.Blind) this.start()
  }

  async reset(onlyResetState = false) {
    clearInterval(this.interval)

    this.started = false
    this.scrambled = false
    this.inSolvingPhase = false
    this.dnf = false
    this.moveHistory = []
    this.undos = 0
    this.time = 0
    this.memoTime = 0
    this.inspecting = false

    if (this.sessionSolves[this.eventName] == null) {
      this.sessionSolves[this.eventName] = []
    }
    this.solves = this.sessionSolves[this.eventName] || []

    if (onlyResetState) return

    this.game.setBoardSize(this.cols, this.rows)
    this.game.blind = false

    if (this.game.noRegrips = this.noRegrips) {
      this.game.activeTile = this.game.board.grid[Math.ceil((this.rows - 1) / 2)][Math.ceil((this.cols - 1) / 2)]
    }

    if (this.db) {
      this.allSolves = (await this.db.getAllFromIndex("solves", "event", this.eventName))
        .map(({ solve }) => Object.freeze({
          ...solve, scramble: new Board(solve.scramble.cols, solve.scramble.rows, solve.scramble.grid)
        })) || []
    }
  }

  done() {
    this.game.blind = false
    this.dnf = !this.game.board.isSolved()
    this.handleSolved()
  }

  undo() {
    if (this.undos == this.moveHistory.length) return
    const move = this.moveHistory[this.moveHistory.length - this.undos - 1]
    this.game.animatedMove(move.axis, move.index, -move.n)
    this.undos += 1
  }

  redo() {
    if (this.undos == 0) return
    const move = this.moveHistory[this.moveHistory.length - this.undos]
    this.game.animatedMove(move.axis, move.index, move.n)
    this.undos -= 1
  }

  inspect(solve: Solve) {
    this.reset(true)
    this.inspecting = true
    this.time = solve.time
    this.dnf = !!solve.dnf

    this.game.board = solve.scramble.clone()
    this.moveHistory = solve.moves
    this.undos = solve.moves.length
  }

  changeSize(size: number) {
    this.custom = false
    this.rows = size
    this.cols = size
    this.reset()
  }

  handleMove(move: Move, isPlayerMove: boolean) {
    if (!isPlayerMove) return

    // start game on first moves
    if (this.scrambled && !this.started) this.start()
    if (!this.started) return

    if (this.undos > 0) {
      this.moveHistory.splice(this.moveHistory.length - this.undos, this.undos)
      this.undos = 0
    }

    for (let i = Math.abs(move.n); i--;) {
      this.moveHistory.push({ ...move, n: Math.sign(move.n), time: Date.now() - this.startTime })
    }

    if (this.event == EventType.Blind) {
      if (!this.inSolvingPhase) {
        this.inSolvingPhase = true
        this.game.blind = true
        this.memoTime = Date.now() - this.startTime
      }
    } else if (this.game.board.isSolved()) {
      this.handleSolved()
    }
  }

  async handleSolved() {
    clearInterval(this.interval)

    this.time = Date.now() - this.startTime
    this.started = false
    this.scrambled = false
    this.inSolvingPhase = false

    const solve: Solve = {
      startTime: this.startTime,
      time: this.time,
      moves: [...this.moveHistory],
      scramble: this.scrambledBoard!
    }

    if (this.memoTime > 0) solve.memoTime = this.memoTime
    if (this.dnf) solve.dnf = true

    this.solves.push(Object.freeze(solve))
    this.allSolves.push(solve)

    if (this.db) {
      if (!this.sessionId) {
        this.sessionId = await this.db.put("sessions", { created: Date.now() }) as number
      }

      this.db.put("solves", {
        event: this.eventName,
        session: this.sessionId,
        solve
      })
    }
  }

  loadFromLocalStorage() {
    if (!localStorage.loopover) return

    const state = JSON.parse(localStorage.loopover) as StoredState
    if (state.version != 0) return

    const { cols, rows, event, ...rest } = state

    this.cols = cols
    this.rows = rows
    this.custom = this.cols != this.rows || this.cols > 10 && this.cols != 20
    this.event = event

    for (let [key, value] of Object.entries(rest)) {
      if (value != null) (this as any)[key] = value
    }
  }

  serialize() {
    const state: StoredState = {
      version: 0,
      cols: this.cols,
      rows: this.rows,
      event: this.event
    }

    if (this.noRegrips) state.noRegrips = true
    if (this.darkText) state.darkText = true
    if (!this.useLetters) state.useLetters = false
    if (this.forceMobile) state.forceMobile = true
    if (this.darkMode) state.darkMode = true

    return state
  }
}

const state = new State()
const vue = new Vue({ data: state })

vue.$watch(() => [state.cols, state.rows, state.event, state.noRegrips], () => {
  state.cols = Math.floor(Math.min(Math.max(state.cols, 1), 50))
  state.rows = Math.floor(Math.min(Math.max(state.rows, 1), 50))

  state.game.setBoardSize(state.cols, state.rows)
  state.reset()
})

vue.$watch(() => [state.darkText, state.useLetters], () => {
  state.game.useLetters = state.useLetters
  state.game.darkText = state.darkText
})

state.loadFromLocalStorage()

vue.$watch(state.serialize, state => {
  localStorage.loopover = JSON.stringify(state)
}, { deep: true })

openDB("loopover", 1, {
  upgrade(db) {
    db.createObjectStore("sessions", { autoIncrement: true, keyPath: "id" })

    const solvesStore = db.createObjectStore("solves", { autoIncrement: true })
    solvesStore.createIndex("event", "event", { unique: false })
    solvesStore.createIndex("session", "session", { unique: false })
  }
}).then(async db => {
  state.db = db
  state.reset()
})

export default state
