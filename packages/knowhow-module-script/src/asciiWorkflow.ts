export type AsciiWorkflowStatus = "pending" | "active" | "completed" | "failed";

export interface AsciiWorkflow {
  stages: Array<{ id: string; label?: string; status?: AsciiWorkflowStatus }>;
  links: Array<{ from: string; to: string; label?: string }>;
}

const SYMBOL: Record<AsciiWorkflowStatus, string> = {
  pending: "○",
  active: "▶",
  completed: "✓",
  failed: "✗",
};

const U = 1;
const R = 2;
const D = 4;
const L = 8;
const LINE = new Map<number, string>([
  [U | D, "│"], [L | R, "─"], [R | D, "┌"], [L | D, "┐"],
  [R | U, "└"], [L | U, "┘"], [U | R | D, "├"], [U | L | D, "┤"],
  [L | R | D, "┬"], [L | R | U, "┴"], [U | R | D | L, "┼"],
]);

class Canvas {
  private cells = new Map<string, string | number>();
  maxX = 0;
  maxY = 0;

  private key(x: number, y: number): string { return `${x},${y}`; }

  line(x: number, y: number, mask: number): void {
    if (x < 0 || y < 0) return;
    const key = this.key(x, y);
    const old = this.cells.get(key);
    this.cells.set(key, (typeof old === "number" ? old : 0) | mask);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  horizontal(x1: number, x2: number, y: number): void {
    const start = Math.min(x1, x2);
    const end = Math.max(x1, x2);
    for (let x = start; x <= end; x++) this.line(x, y, (x > start ? L : 0) | (x < end ? R : 0));
  }

  vertical(x: number, y1: number, y2: number): void {
    const start = Math.min(y1, y2);
    const end = Math.max(y1, y2);
    for (let y = start; y <= end; y++) this.line(x, y, (y > start ? U : 0) | (y < end ? D : 0));
  }

  text(x: number, y: number, value: string): void {
    [...value].forEach((character, offset) => this.cells.set(this.key(x + offset, y), character));
    this.maxX = Math.max(this.maxX, x + [...value].length - 1);
    this.maxY = Math.max(this.maxY, y);
  }

  render(): string[] {
    const rows: string[] = [];
    for (let y = 0; y <= this.maxY; y++) {
      let row = "";
      for (let x = 0; x <= this.maxX; x++) {
        const value = this.cells.get(this.key(x, y));
        row += typeof value === "number" ? (LINE.get(value) ?? "·") : (value ?? " ");
      }
      rows.push(row.trimEnd());
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    while (rows.length && !rows[0]) rows.shift();
    return rows;
  }
}

interface PositionedStage {
  id: string;
  text: string;
  width: number;
  rank: number;
  x: number;
  y: number;
}

/**
 * Draw a small workflow as a connected, top-to-bottom terminal diagram.
 *
 * The layout is intentionally dependency-free. DFS back edges are routed around
 * the right side of the drawing, which keeps cycles from affecting node ranks.
 */
export function renderAsciiWorkflow(workflow: AsciiWorkflow): string[] {
  if (workflow.stages.length === 0) return ["No workflow stages declared."];

  const stageIds = new Set(workflow.stages.map((stage) => stage.id));
  const links = workflow.links.filter((link) => stageIds.has(link.from) && stageIds.has(link.to));
  const outgoing = new Map<string, typeof links>();
  for (const stage of workflow.stages) outgoing.set(stage.id, []);
  for (const link of links) outgoing.get(link.from)?.push(link);

  // DFS identifies edges to an ancestor. Excluding those edges makes the graph
  // rankable while preserving the cycle as an explicitly routed back edge.
  const state = new Map<string, 0 | 1 | 2>();
  const backEdges = new Set<(typeof links)[number]>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const link of outgoing.get(id) ?? []) {
      const targetState = state.get(link.to) ?? 0;
      if (targetState === 1) backEdges.add(link);
      else if (targetState === 0) visit(link.to);
    }
    state.set(id, 2);
  };
  for (const stage of workflow.stages) if (!state.get(stage.id)) visit(stage.id);

  const forward = links.filter((link) => !backEdges.has(link));
  const rank = new Map(workflow.stages.map((stage) => [stage.id, 0]));
  // Longest-path relaxation is bounded; after DFS back-edge removal this is a DAG.
  for (let pass = 0; pass < workflow.stages.length; pass++) {
    let changed = false;
    for (const link of forward) {
      const next = (rank.get(link.from) ?? 0) + 1;
      if (next > (rank.get(link.to) ?? 0)) {
        rank.set(link.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, PositionedStage[]>();
  const nodes = new Map<string, PositionedStage>();
  for (const stage of workflow.stages) {
    const status = stage.status ?? "pending";
    const text = `${SYMBOL[status]} ${stage.id}${stage.label && stage.label !== stage.id ? ` — ${stage.label}` : ""}`;
    const node: PositionedStage = { id: stage.id, text, width: [...text].length + 4, rank: rank.get(stage.id) ?? 0, x: 0, y: 0 };
    nodes.set(stage.id, node);
    const layer = layers.get(node.rank) ?? [];
    layer.push(node);
    layers.set(node.rank, layer);
  }

  const nodeGap = 6;
  const layerWidths = [...layers.values()].map((layer) => layer.reduce((sum, node) => sum + node.width, 0) + nodeGap * (layer.length - 1));
  const contentWidth = Math.max(...layerWidths);
  for (const [layerRank, layer] of layers) {
    const layerWidth = layer.reduce((sum, node) => sum + node.width, 0) + nodeGap * (layer.length - 1);
    let x = 2 + Math.floor((contentWidth - layerWidth) / 2);
    for (const node of layer) {
      node.x = x;
      node.y = 1 + layerRank * 7;
      x += node.width + nodeGap;
    }
  }

  const canvas = new Canvas();
  const routeByRank = new Map<number, number>();
  for (const link of forward) {
    const from = nodes.get(link.from)!;
    const to = nodes.get(link.to)!;
    const fromX = from.x + Math.floor(from.width / 2);
    const toX = to.x + Math.floor(to.width / 2);
    const routeIndex = routeByRank.get(from.rank) ?? 0;
    routeByRank.set(from.rank, routeIndex + 1);
    const routeY = from.y + 3 + routeIndex;
    canvas.vertical(fromX, from.y + 2, routeY);
    canvas.horizontal(fromX, toX, routeY);
    canvas.vertical(toX, routeY, to.y - 1);
    canvas.text(toX, to.y - 1, "▼");
    if (link.label) {
      const label = ` ${link.label} `;
      if (fromX === toX) canvas.text(fromX + 2, routeY, label.trim());
      else canvas.text(Math.min(fromX, toX) + Math.max(1, Math.floor(Math.abs(toX - fromX) / 2 - label.length / 2)), routeY, label);
    }
  }

  const cycleBaseX = 2 + contentWidth + 3;
  [...backEdges].forEach((link, index) => {
    const from = nodes.get(link.from)!;
    const to = nodes.get(link.to)!;
    const laneX = cycleBaseX + index * 4;
    const fromY = from.y + 1;
    const toY = to.y + 1;
    canvas.horizontal(from.x + from.width - 1, laneX, fromY);
    canvas.vertical(laneX, fromY, toY);
    canvas.horizontal(to.x + to.width, laneX, toY);
    canvas.text(to.x + to.width, toY, "◀");
    if (link.label) canvas.text(laneX + 1, Math.floor((fromY + toY) / 2), ` ${link.label}`);
  });

  for (const node of nodes.values()) {
    canvas.horizontal(node.x, node.x + node.width - 1, node.y);
    canvas.horizontal(node.x, node.x + node.width - 1, node.y + 2);
    canvas.vertical(node.x, node.y, node.y + 2);
    canvas.vertical(node.x + node.width - 1, node.y, node.y + 2);
    canvas.text(node.x + 2, node.y + 1, node.text);
  }

  return canvas.render();
}
