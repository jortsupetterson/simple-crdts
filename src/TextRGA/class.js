/**
 * TextRGA - state-based text CRDT.
 *
 * Model:
 *  - Each character has a globally unique id: `${nodeId}:${counter}`
 *  - Characters are never removed, only tombstoned (deleted = true)
 *  - Order is derived deterministically by sorting ids
 *  - Merge = union of characters + deleted = deletedA || deletedB
 */
export class TextRGA {
  /**
   * @param {string} localNodeId
   * @param {number} [localCounter]
   * @param {{[id: string]: {char: string, deleted: boolean}}} [entries]
   * @param {string[]} [order]
   * @param {(info: {index:number,id:string,char:string}) => void} [onInsert]
   * @param {(info: {index:number,id:string}) => void} [onDelete]
   */
  constructor(
    localNodeId,
    localCounter = 0,
    entries = {},
    order = [],
    onInsert = undefined,
    onDelete = undefined
  ) {
    this.localNodeId = localNodeId;
    this.localCounter = localCounter;
    this.entries = { ...entries }; // id -> { char, deleted }
    this.order = order.slice(); // array of ids, for fast traversal
    this.onInsert = onInsert || null;
    this.onDelete = onDelete || null;
  }

  /**
   * Allocate a new globally unique id for this replica.
   * @returns {string}
   */
  #nextId() {
    this.localCounter += 1;
    return `${this.localNodeId}:${this.localCounter}`;
  }

  /**
   * Insert a single character at logical index among visible characters.
   * @param {number} index 0-based index over *visible* characters
   * @param {string} char single-character string
   * @returns {string} id of the inserted character
   */
  insertAt(index, char) {
    if (typeof char !== "string" || char.length !== 1) {
      throw new TypeError(
        "TextRGA.insertAt expects a single character string."
      );
    }

    const id = this.#nextId();

    // Build the visible sequence of ids
    const visibleIds = this.order.filter(
      (entryId) => !this.entries[entryId]?.deleted
    );

    // Clamp index
    const clampedIndex = Math.max(0, Math.min(index, visibleIds.length));

    // We insert relative to visible indices, but maintain full order[]
    const newOrder = [];
    let visiblePos = 0;

    for (const entryId of this.order) {
      const entry = this.entries[entryId];
      if (!entry?.deleted) {
        if (visiblePos === clampedIndex) {
          newOrder.push(id);
        }
        visiblePos += 1;
      }
      newOrder.push(entryId);
    }

    // If we insert at the end, we may not have pushed id above
    if (clampedIndex === visibleIds.length && !newOrder.includes(id)) {
      newOrder.push(id);
    }

    this.order = newOrder;
    this.entries[id] = { char, deleted: false };

    if (this.onInsert) {
      this.onInsert({ index: clampedIndex, id, char });
    }

    return id;
  }

  /**
   * Tombstone character at logical index among visible characters.
   * @param {number} index 0-based index over *visible* characters
   */
  deleteAt(index) {
    const visibleIds = this.order.filter(
      (entryId) => !this.entries[entryId]?.deleted
    );

    if (index < 0 || index >= visibleIds.length) return;

    const id = visibleIds[index];
    const entry = this.entries[id];
    if (!entry) return;

    entry.deleted = true;

    if (this.onDelete) {
      this.onDelete({ index, id });
    }
  }

  /**
   * Merge another TextRGA into this one (idempotent, commutative, associative).
   * @param {TextRGA} other
   * @returns {TextRGA} this
   */
  merge(other) {
    // Merge entries (grow-only + tombstone OR)
    for (const id in other.entries) {
      const remote = other.entries[id];
      const local = this.entries[id];

      if (!local) {
        // New character from other replica
        this.entries[id] = { char: remote.char, deleted: !!remote.deleted };
      } else {
        // Same character: OR the deleted flags
        local.deleted = local.deleted || !!remote.deleted;
      }
    }

    // Merge order: union of ids, then deterministic sort
    const idSet = new Set([
      ...this.order,
      ...other.order,
      ...Object.keys(this.entries),
    ]);
    this.order = Array.from(idSet).sort(); // sort by id string -> deterministic

    // Local counter should at least be as large as any local id we've generated;
    // we do NOT try to "merge" counters globally here.
    this.localCounter = Math.max(this.localCounter, other.localCounter || 0);

    return this;
  }

  /**
   * Materialize current visible text.
   * @returns {string}
   */
  getText() {
    let result = "";
    for (const id of this.order) {
      const entry = this.entries[id];
      if (entry && !entry.deleted) {
        result += entry.char;
      }
    }
    return result;
  }

  /**
   * JSON storage/transport representation (IDB, network).
   * (callbacks are intentionally not serialized)
   */
  toJSON() {
    return {
      localNodeId: this.localNodeId,
      localCounter: this.localCounter,
      entries: this.entries,
      order: this.order,
    };
  }

  /**
   * Rehydrate from JSON (callbacks must be wired manually afterwards).
   * @param {{localNodeId: string, localCounter?: number, entries?: {[id: string]: {char: string, deleted: boolean}}, order?: string[]}} json
   * @returns {TextRGA}
   */
  static fromJSON(json) {
    return new TextRGA(
      json.localNodeId,
      json.localCounter || 0,
      json.entries || {},
      json.order || []
    );
  }
}
