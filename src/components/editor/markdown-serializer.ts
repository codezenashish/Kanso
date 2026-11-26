import type { Mark, Node as EditorNode } from '@tiptap/pm/model';

type TextLikeNode = EditorNode & { withText(text: string): EditorNode };

export type NodeSerializer = (
  state: MarkdownSerializerState,
  node: EditorNode,
  parent: EditorNode,
  index: number,
) => void;

export type MarkSerializer = {
  open: string | ((state: MarkdownSerializerState, mark: Mark, parent: EditorNode, index: number) => string);
  close: string | ((state: MarkdownSerializerState, mark: Mark, parent: EditorNode, index: number) => string);
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
};

export type MarkdownSerializerOptions = {
  tightLists?: boolean;
  escapeExtraCharacters?: RegExp;
  hardBreakNodeName?: string;
  strict?: boolean;
};

const blankMark: MarkSerializer = { open: '', close: '', mixable: true };

function backticksFor(node: EditorNode, side: number): string {
  const ticks = /`+/g;
  let match: RegExpExecArray | null;
  let len = 0;
  if (node.isText && node.text) {
    while ((match = ticks.exec(node.text))) {
      len = Math.max(len, match[0].length);
    }
  }
  let result = len > 0 && side > 0 ? ' `' : '`';
  for (let i = 0; i < len; i++) result += '`';
  if (len > 0 && side < 0) result += ' ';
  return result;
}

function isPlainURL(link: Mark, parent: EditorNode, index: number): boolean {
  if (link.attrs.title || !/^\w+:/.test(String(link.attrs.href ?? ''))) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== link.attrs.href || content.marks[content.marks.length - 1] !== link) {
    return false;
  }
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}

export class MarkdownSerializerState {
  delim = '';
  out = '';
  last = '';
  closed: EditorNode | null = null;
  inAutolink: boolean | undefined = undefined;
  atBlockStart = false;
  inTightList = false;

  constructor(
    readonly nodes: Record<string, NodeSerializer>,
    readonly marks: Record<string, MarkSerializer>,
    readonly options: MarkdownSerializerOptions,
  ) {
    if (this.options.tightLists === undefined) this.options.tightLists = false;
    if (this.options.hardBreakNodeName === undefined) this.options.hardBreakNodeName = 'hardBreak';
  }

  flushClose(size = 2) {
    if (!this.closed) return;
    if (!this.atBlank()) this.append('\n');
    if (size > 1) {
      let delimMin = this.delim;
      const trim = /\s+$/.exec(delimMin);
      if (trim) delimMin = delimMin.slice(0, delimMin.length - trim[0].length);
      for (let i = 1; i < size; i++) this.append(`${delimMin}\n`);
    }
    this.closed = null;
  }

  getMark(name: string): MarkSerializer {
    const info = this.marks[name];
    if (!info) {
      if (this.options.strict !== false) {
        throw new Error(`Mark type \`${name}\` not supported by Markdown renderer`);
      }
      return blankMark;
    }
    return info;
  }

  wrapBlock(delim: string, firstDelim: string | null, node: EditorNode, f: () => void) {
    const old = this.delim;
    this.write(firstDelim ?? delim);
    this.delim += delim;
    f();
    this.delim = old;
    this.closeBlock(node);
  }

  atBlank(): boolean {
    return !this.out || this.last[this.last.length - 1] === '\n';
  }

  ensureNewLine() {
    if (!this.atBlank()) this.append('\n');
  }

  append(text: string) {
    if (!text) return;
    this.out += text;
    this.last = text.length > 1 ? text : this.last.slice(-1) + text;
  }

  write(content?: string) {
    this.flushClose();
    if (this.delim && this.atBlank()) this.append(this.delim);
    if (content) this.append(content);
  }

  closeBlock(node: EditorNode) {
    this.closed = node;
  }

  text(text: string, escape = true) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      this.write();
      if (!escape && lines[i][0] === '[' && /!$/.test(this.last)) {
        let escaped = this.last.length > 1 && this.last[this.last.length - 2] === '\\';
        if (escaped) {
          let backslashes = 1;
          for (let j = this.out.length - 2; j > 0; j--) {
            if (this.out[j - 1] === '\\') backslashes++;
            else break;
          }
          escaped = backslashes % 2 > 0;
        }
        if (!escaped) this.out = `${this.out.slice(0, this.out.length - 1)}\\!`;
      }
      this.append(escape ? this.esc(lines[i], this.atBlockStart) : lines[i]);
      if (i !== lines.length - 1) this.append('\n');
    }
  }

  render(node: EditorNode, parent: EditorNode, index: number) {
    const handler = this.nodes[node.type.name];
    if (handler) {
      handler(this, node, parent, index);
      return;
    }
    if (this.options.strict !== false) {
      throw new Error(`Token type \`${node.type.name}\` not supported by Markdown renderer`);
    }
    if (!node.type.isLeaf) {
      if (node.type.inlineContent) this.renderInline(node);
      else this.renderContent(node);
      if (node.isBlock) this.closeBlock(node);
    }
  }

  renderContent(parent: EditorNode) {
    parent.forEach((node, _offset, i) => this.render(node, parent, i));
  }

  renderInline(parent: EditorNode, fromBlockStart = true) {
    this.atBlockStart = fromBlockStart;
    const active: Mark[] = [];
    let trailing = '';

    const progress = (node: EditorNode | null, _offset: number, index: number) => {
      let marks = node ? node.marks : [];
      if (node && node.type.name === this.options.hardBreakNodeName) {
        marks = marks.filter((mark) => {
          if (index + 1 === parent.childCount) return false;
          const next = parent.child(index + 1);
          return Boolean(mark.isInSet(next.marks)) && (!next.isText || /\S/.test(next.text ?? ''));
        });
      }

      const inner = marks.length ? marks[marks.length - 1] : null;
      const noEsc = Boolean(inner && this.getMark(inner.type.name).escape === false);
      const len = marks.length - (noEsc ? 1 : 0);

      outer: for (let i = 0; i < len; i++) {
        const mark = marks[i];
        if (!this.getMark(mark.type.name).mixable) break;
        for (let j = 0; j < active.length; j++) {
          const other = active[j];
          if (!this.getMark(other.type.name).mixable) break;
          if (mark.eq(other)) {
            if (i > j) {
              marks = marks.slice(0, j).concat(mark).concat(marks.slice(j, i)).concat(marks.slice(i + 1, len));
            } else if (j > i) {
              marks = marks.slice(0, i).concat(marks.slice(i + 1, j)).concat(mark).concat(marks.slice(j, len));
            }
            continue outer;
          }
        }
      }

      let keep = 0;
      while (keep < Math.min(active.length, len) && marks[keep].eq(active[keep])) ++keep;

      let leading = trailing;
      trailing = '';

      if (node && node.isText && node.text && marks.length > keep && this.getMark(marks[marks.length - 1].type.name).expelEnclosingWhitespace) {
        const [, lead, rest] = /^(\s*)(.*)$/m.exec(node.text)!;
        if (lead) {
          leading += lead;
          node = rest ? (node as TextLikeNode).withText(rest) : null;
          if (!node) marks = active;
        }
      }

      if (node && node.isText && node.text && marks.length) {
        for (let i = marks.length - 1; i >= 0; i--) {
          const mark = marks[i];
          if (!this.getMark(mark.type.name).expelEnclosingWhitespace) break;
          if (!this.isMarkAhead(parent, index + 1, mark)) {
            const [, rest, trail] = /^(.*?)(\s*)$/m.exec(node.text)!;
            if (trail) {
              trailing = trail;
              node = rest ? (node as TextLikeNode).withText(rest) : null;
              if (!node) marks = active;
            }
            break;
          }
        }
      }

      if (node || index === parent.childCount) {
        while (keep < active.length) {
          this.text(this.markString(active.pop()!, false, parent, index), false);
        }
      }

      if (leading) this.text(leading);

      if (node) {
        while (active.length < len) {
          const add = marks[active.length];
          active.push(add);
          this.text(this.markString(add, true, parent, index), false);
          this.atBlockStart = false;
        }

        if (noEsc && node.isText && inner) {
          this.text(
            this.markString(inner, true, parent, index)
              + (node.text ?? '')
              + this.markString(inner, false, parent, index + 1),
            false,
          );
        } else {
          this.render(node, parent, index);
        }
        this.atBlockStart = false;
      }
    };

    parent.forEach(progress);
    progress(null, 0, parent.childCount);
    this.atBlockStart = false;
  }

  renderList(node: EditorNode, delim: string, firstDelim: (index: number) => string) {
    if (this.closed && this.closed.type === node.type) this.flushClose(3);
    else if (this.inTightList) this.flushClose(1);

    const isTight = node.attrs.tight !== undefined ? Boolean(node.attrs.tight) : Boolean(this.options.tightLists);
    const prevTight = this.inTightList;
    this.inTightList = isTight;
    node.forEach((child, _offset, i) => {
      if (i && isTight) this.flushClose(1);
      this.wrapBlock(delim, firstDelim(i), node, () => this.render(child, node, i));
    });
    this.inTightList = prevTight;
  }

  esc(str: string, startOfLine = false): string {
    let result = str.replace(/[`*\\~[\]_]/g, (m, i) => (
      m === '_' && i > 0 && i + 1 < str.length && /\w/.test(str[i - 1]) && /\w/.test(str[i + 1]) ? m : `\\${m}`
    ));
    if (startOfLine) {
      result = result
        .replace(/^(\+[ ]|[-*>])/, '\\$&')
        .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
        .replace(/^(\s*\d+)\.\s/, '$1\\. ');
    }
    if (this.options.escapeExtraCharacters) {
      result = result.replace(this.options.escapeExtraCharacters, '\\$&');
    }
    return result;
  }

  repeat(str: string, n: number): string {
    return str.repeat(n);
  }

  markString(mark: Mark, open: boolean, parent: EditorNode, index: number): string {
    const info = this.getMark(mark.type.name);
    const value = open ? info.open : info.close;
    return typeof value === 'string' ? value : value(this, mark, parent, index);
  }

  private isMarkAhead(parent: EditorNode, index: number, mark: Mark): boolean {
    for (; index < parent.childCount; index++) {
      const next = parent.child(index);
      if (next.type.name !== this.options.hardBreakNodeName && (!next.text || /\S/.test(next.text))) {
        for (let i = next.marks.length - 1; i >= 0; i--) {
          const m = next.marks[i];
          if (m.eq(mark)) return true;
          if (!this.getMark(m.type.name).mixable) break;
        }
        return false;
      }
      index++;
    }
    return false;
  }
}

export class MarkdownSerializer {
  constructor(
    readonly nodes: Record<string, NodeSerializer>,
    readonly marks: Record<string, MarkSerializer>,
    readonly options: MarkdownSerializerOptions = {},
  ) {}

  serialize(content: EditorNode, options: MarkdownSerializerOptions = {}): string {
    const state = new MarkdownSerializerState(this.nodes, this.marks, { ...this.options, ...options });
    state.renderContent(content);
    return state.out;
  }
}

export const defaultTiptapMarkdownNodes: Record<string, NodeSerializer> = {
  blockquote(state, node) {
    state.wrapBlock('> ', null, node, () => state.renderContent(node));
  },
  codeBlock(state, node) {
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : '```';
    state.write(`${fence}${node.attrs.params || ''}\n`);
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },
  heading(state, node) {
    state.write(`${state.repeat('#', Number(node.attrs.level ?? 1))} `);
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontalRule(state, node) {
    state.write(String(node.attrs.markup || '---'));
    state.closeBlock(node);
  },
  bulletList(state, node) {
    state.renderList(node, '  ', () => `${node.attrs.bullet || '*'} `);
  },
  orderedList(state, node) {
    const start = Number(node.attrs.start ?? 1);
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(' ', maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i);
      return `${state.repeat(' ', maxW - nStr.length)}${nStr}. `;
    });
  },
  listItem(state, node) {
    state.renderContent(node);
  },
  paragraph(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  image(state, node) {
    const alt = state.esc(String(node.attrs.alt || ''));
    const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
    const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
    state.write(`![${alt}](${src}${title})`);
  },
  hardBreak(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        state.write('\\\n');
        return;
      }
    }
  },
  text(state, node) {
    state.text(node.text ?? '', !state.inAutolink);
  },
};

export const defaultTiptapMarkdownMarks: Record<string, MarkSerializer> = {
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  link: {
    open(state, mark, parent, index) {
      state.inAutolink = isPlainURL(mark, parent, index);
      return state.inAutolink ? '<' : '[';
    },
    close(state, mark) {
      const { inAutolink } = state;
      state.inAutolink = undefined;
      if (inAutolink) return '>';
      const href = String(mark.attrs.href ?? '').replace(/[()"]/g, '\\$&');
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : '';
      return `](${href}${title})`;
    },
    mixable: true,
  },
  code: {
    open(_state, _mark, parent, index) {
      return backticksFor(parent.child(index), -1);
    },
    close(_state, _mark, parent, index) {
      return backticksFor(parent.child(index - 1), 1);
    },
    escape: false,
  },
};
