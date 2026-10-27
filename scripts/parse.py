"""Parse the EDGAR S-1 (PDF-style absolutely positioned HTML) into sections -> data/sections.json.

Usage: python3 -I scripts/parse.py data/s1.htm data/sections.json
"""
import html.parser, json, re, sys

PX = re.compile(r'(top|font-size|left|height|width):([\d.]+)pt')


def style(attrs):
    s = dict(attrs).get('style', '') or ''
    d = {k: float(v) for k, v in PX.findall(s)}
    d['bold'] = 'font-weight:bold' in s
    d['italic'] = 'font-style:italic' in s
    return d


class Lines(html.parser.HTMLParser):
    """Collect one record per visual line: page, top, text runs with size/bold."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.page, self.lines, self.anchor = 0, [], None
        self.stack, self.line, self.fonts = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == 'div':
            st = style(attrs)
            a = dict(attrs)
            if st.get('height') == 792:
                self.page += 1
            if a.get('id'):
                self.anchor = a['id']
            opens_line = 'top' in st and self.line is None and not a.get('id')
            if opens_line:
                self.line = {'page': self.page, 'top': st['top'], 'runs': [], 'anchor': self.anchor}
                self.anchor = None
            self.stack.append(opens_line)
        elif tag == 'font':  # nested fonts inherit size/weight from the enclosing one
            st = style(attrs)
            parent = self.fonts[-1] if self.fonts else {}
            self.fonts.append({**parent, **{k: v for k, v in st.items() if v or k not in parent}})

    def handle_endtag(self, tag):
        if tag == 'div' and self.stack and self.stack.pop() and self.line is not None:
            if any(r['t'].strip() for r in self.line['runs']):
                self.lines.append(self.line)
            self.line = None
        elif tag == 'font' and self.fonts:
            self.fonts.pop()
        elif tag in ('td', 'tr') and self.line is not None:
            runs = self.line['runs']
            sep = ' | ' if tag == 'td' else '\n'
            if runs and runs[-1]['t'].strip(' |') :  # skip empty cells
                runs.append({**runs[-1], 't': sep, 'w': 0, 'left': 0})
            elif runs and tag == 'tr' and runs[-1]['t'] == ' | ':
                runs[-1] = {**runs[-1], 't': sep}

    def handle_data(self, data):
        if self.line is not None and self.fonts:
            f = self.fonts[-1]
            self.line['runs'].append({'t': data, 'size': f.get('font-size', 0), 'bold': f['bold'],
                                      'italic': f['italic'], 'left': f.get('left', 0), 'w': f.get('width', 0)})


def line_text(runs):
    out, end = '', None
    for r in runs:
        # wide horizontal gap between runs = table cell boundary. Table runs carry no width,
        # so estimate ~0.5em/char for body-size text (headings are kerned into runs; skip them).
        if r['t'] in (' | ', '\n'):
            out, end = out + r['t'], None
            continue
        if end is not None and r['left'] - end > max(12, r['size'] * 1.5) and out.strip():
            out += ' | '
        out += r['t']
        w = r['w'] or (len(r['t']) * r['size'] * 0.5 if r['size'] < 12 else 0)
        end = r['left'] + w if w else None
    out = re.sub(r'[ \t]+', ' ', out)
    out = re.sub(r'([$(]) \| ', r'\1', out)
    return re.sub(r' ?\| ?(?=\n|$)|(?<=\n) ', '', out).strip()


SKIP = re.compile(r'(\d+|[ivx]+|Table of Contents|Contents|F-\d+|II-\d+)')
MAX_CHUNK = 2500
# cover pages and the F-pages are headed by the company name; give them useful titles
TITLE_FIX = {1: 'Registration Statement Cover', 2: 'Prospectus Cover', 372: 'Consolidated Financial Statements'}


def build(lines):
    """-> (sections, chunks). A chunk is the text under one heading, split at paragraphs past MAX_CHUNK."""
    sections, chunks, para, paras = [], [], [], []
    sec = sub = head = None
    prev = None
    state = {'page': 0}
    labels = {}  # html page index -> printed page number ("45", "F-12")

    def flush_para():
        if para:
            paras.append(join_lines(para))
            para.clear()

    def flush_chunk():
        flush_para()
        if not paras or sec is None:
            paras.clear()
            return
        heading = ' › '.join(h for h in (sub, head) if h)
        buf = []
        for p in paras + [None]:
            if p is None or buf and sum(map(len, buf)) + len(p) > MAX_CHUNK:
                chunks.append({'id': f'c{len(chunks) + 1}', 'sec': sec['id'], 'head': heading,
                               'page': state['page'], 'text': '\n\n'.join(buf)})
                buf = []
            if p is not None:
                buf.append(p)
        paras.clear()

    for ln in lines:
        text = line_text(ln['runs'])
        runs = [r for r in ln['runs'] if r['t'].strip()]
        size = max(r['size'] for r in runs)
        bold = all(r['bold'] for r in runs)
        italic = all(r['italic'] for r in runs)
        if SKIP.fullmatch(text):
            if re.fullmatch(r'(\d+|[ivx]+|F-\d+|II-\d+)', text):
                labels[ln['page']] = text
            continue
        kind = ('sec' if bold and size >= 16 else 'sub' if bold and size >= 11.5 and not italic
                else 'head' if bold and size >= 10 and not italic else 'rf' if bold and italic and size >= 9.5
                else 'body')
        same_block = prev and prev['kind'] == kind and ln['page'] == prev['page'] and ln['top'] - prev['top'] < 30
        if kind == 'sec':
            if same_block:
                sec['title'] += ' ' + text
            elif not (sec and sec['title'] == text):
                flush_chunk()
                sec = {'id': f's{len(sections) + 1}', 'title': text, 'page': ln['page'], 'anchor': ln['anchor']}
                sections.append(sec)
                sub = head = None
                state['page'] = ln['page']
        elif kind in ('sub', 'head'):
            if same_block:
                if kind == 'sub': sub += ' ' + text
                else: head += ' ' + text
            else:
                flush_chunk()
                state['page'] = ln['page']
                if kind == 'sub': sub, head = text, None
                else: head = text
        elif kind == 'rf':
            if not same_block:  # a risk-factor headline starts its own chunk and leads it
                flush_chunk()
                state['page'] = ln['page']
            para.append(text)
        elif '\n' in text:  # a whole table arrives as one line
            flush_para()
            paras.append(text)
        else:
            if prev and prev['kind'] == 'rf' or prev and ln['page'] == prev['page'] and ln['top'] - prev['top'] > 16:
                flush_para()
            if not paras and not para:
                state['page'] = ln['page']
            para.append(text)
        prev = {'kind': kind, 'page': ln['page'], 'top': ln['top']}
    flush_chunk()
    for c in chunks:
        c['page'] = labels.get(c['page'], str(c['page']))
    used = {c['sec'] for c in chunks}
    return [s for s in sections if s['id'] in used], chunks


def join_lines(lines):
    out = ''
    for t in lines:
        out += t if not out or out.endswith('-') else ' ' + t
    return out


def main(src, dst):
    p = Lines()
    p.feed(open(src, encoding='utf-8', errors='replace').read())
    sections, chunks = build(p.lines)
    for s in sections:
        s['title'] = TITLE_FIX.get(s['page'], s['title'])
    # F-pages: the auditor reports carry section-size headings; fold them under one section
    fin = next(s for s in sections if s['title'] == 'Consolidated Financial Statements')
    part2 = next(s for s in sections if s['title'] == 'Part II')
    folded = {s['id']: s['title'] for s in sections if fin['page'] < s['page'] < part2['page']}
    for c in chunks:
        if c['sec'] in folded:
            c['head'] = ' › '.join(filter(None, (folded[c['sec']], c['head'])))
            c['sec'] = fin['id']
    sections = [s for s in sections if s['id'] not in folded]
    json.dump({'sections': sections, 'chunks': chunks}, open(dst, 'w'), ensure_ascii=False)
    print(f'{p.page} pages, {len(p.lines)} lines, {len(sections)} sections, {len(chunks)} chunks')
    for s in sections:
        n = [c for c in chunks if c['sec'] == s['id']]
        print(f"{s['id']:>5} p{s['page']:<4} {len(n):>4} chunks  {s['title'][:80]}")


if __name__ == '__main__':
    main(*sys.argv[1:3])
