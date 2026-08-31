#!/usr/bin/env python3
"""
Turn raw ladder screenshots into Chrome Web Store images.

Store screenshots must be exactly 1280x800, and they must not publish anyone's
account name — least of all the opponent's, who did not agree to appear in a
listing. This finds every occurrence of both handles with OCR (the panel's own
header included), paints it out against the surrounding background, and writes
a same-length placeholder in its place, then blurs the players' chat and the
site's ad rail.

    python3 scripts/anonymise-shots.py OUT_DIR SHOT.png [SHOT.png ...]

Nothing the extension itself renders is altered beyond the handle.
"""
import sys, os
from statistics import median
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import pytesseract

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
# OCR misreads these handles in predictable ways (l/I/1, o/0), so match on
# fragments rather than the exact string.
MINE  = ['725', 'nbl', 'nbi', 'nb!', '50nb', '250n']
THEIRS = ['inhe', 'heso', 'tinh']
FRAG = MINE + THEIRS
A1, A2 = 'PlayerA', 'PlayerB'      # same length as the handles they replace

def ring_bg(im, box):
    """Median of the pixels just outside the box: the background to paint with.
    Sampling inside would be biased by the glyphs we are removing."""
    x0, y0, x1, y1 = box
    pts = []
    for x in range(max(x0-3, 0), min(x1+3, im.width), 2):
        for y in (max(y0-3, 0), min(y1+2, im.height-1)): pts.append(im.getpixel((x, y)))
    for y in range(max(y0-3, 0), min(y1+3, im.height), 2):
        for x in (max(x0-3, 0), min(x1+2, im.width-1)): pts.append(im.getpixel((x, y)))
    return tuple(int(median([p[i] for p in pts])) for i in range(3))

def relabel(im, box, text, bold=False):
    x0, y0, x1, y1 = box
    bg = ring_bg(im, box)
    lum = lambda c: .299*c[0] + .587*c[1] + .114*c[2]
    fg = max(list(im.crop(box).getdata()), key=lambda c: abs(lum(c) - lum(bg)))
    d = ImageDraw.Draw(im)
    d.rectangle((x0-1, y0-1, x1+1, y1+1), fill=bg)
    h = y1 - y0
    size = max(int(h * 0.95), 9)
    f = ImageFont.truetype(BOLD if bold else FONT, size)
    while size > 8 and (f.getbbox(text)[2] - f.getbbox(text)[0]) > (x1 - x0):
        size -= 1
        f = ImageFont.truetype(BOLD if bold else FONT, size)
    b = f.getbbox(text)
    d.text((x0 - b[0], y0 + (h - (b[3]-b[1]))/2 - b[1]), text, font=f, fill=fg)

def alias(tok):
    return A1 if any(x in tok.lower() for x in MINE) else A2

def scan(im, region=None, psm=None, scale=3):
    """OCR at magnification — this text is 12px and tesseract needs the help."""
    x0, y0 = (region[0], region[1]) if region else (0, 0)
    c = im.crop(region) if region else im
    big = c.resize((c.width*scale, c.height*scale), Image.LANCZOS)
    cfg = f'--psm {psm}' if psm else ''
    d = pytesseract.image_to_data(big, config=cfg, output_type=pytesseract.Output.DICT)
    out = []
    for i, t in enumerate(d['text']):
        t = t.strip()
        if t and any(f in t.lower() for f in FRAG):
            out.append((t, x0 + d['left'][i]//scale, y0 + d['top'][i]//scale,
                        d['width'][i]//scale, d['height'][i]//scale))
    return out

def blur(im, box, r=20):
    box = (box[0], box[1], min(box[2], im.width), min(box[3], im.height))
    im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(r)), box)

def fit(im, w=1280, h=800, ground=(15, 18, 24)):
    """Exactly 1280x800. A browser window is wider than 1.6, so it letterboxes
    rather than cropping away either the battle or the panel."""
    r = min(w/im.width, h/im.height)
    i2 = im.resize((round(im.width*r), round(im.height*r)), Image.LANCZOS)
    c = Image.new('RGB', (w, h), ground)
    c.paste(i2, ((w - i2.width)//2, (h - i2.height)//2))
    return c

# Where the handles live, besides the battle log. Scoped OCR rather than pinned
# pixels, so small differences between screenshots don't matter.
REGIONS = [(2430, 110, 2790, 205),    # account name, top right
           (10, 580, 240, 730),       # our trainer label on the field
           (1180, 250, 1420, 360),    # their trainer label on the field
           (2270, 235, 2440, 315)]    # the panel's own header
SUBTITLE = (460, 125, 840, 215)       # the battle tab's "A vs. B"
CHATLABEL = (1380, 1480, 1720, 10**6)

def process(path, out_dir, chat_blur=None, ad_blur=None, erase=()):
    im = Image.open(path).convert('RGB')
    painted = []
    def done_overlap(x0, y0, x1, y1):
        for p in painted:
            if not (x0 > p[2] or x1 < p[0] or y0 > p[3] or y1 < p[1]): return True
        painted.append((x0, y0, x1, y1))
        return False
    if chat_blur: blur(im, chat_blur)     # the players' conversation
    if ad_blur:   blur(im, ad_blur)       # the site's ad rail
    # Lines that are only handles and carry nothing about the product — the
    # "X and Y joined" header. Cheaper to erase than to reconstruct.
    for box in erase:
        ImageDraw.Draw(im).rectangle(box, fill=ring_bg(im, box))
    n = 0

    # "A vs. B" is one phrase: replacing the names separately paints over the
    # "vs." and leaves a dangling handle.
    sub = scan(im, SUBTITLE, psm=6, scale=5)
    if len(sub) >= 2:
        relabel(im, (min(b[1] for b in sub), min(b[2] for b in sub),
                     max(b[1]+b[3] for b in sub), max(b[2]+b[4] for b in sub)),
                f'{A1} vs. {A2}')
        done_overlap(min(b[1] for b in sub)-3, min(b[2] for b in sub)-3,
                     max(b[1]+b[3] for b in sub)+3, max(b[2]+b[4] for b in sub)+3)
        n += 1

    for tok, x, y, w, h in scan(im, (CHATLABEL[0], CHATLABEL[1], CHATLABEL[2], im.height),
                                psm=6, scale=5):
        # Pad right: OCR clips the trailing colon, which would otherwise
        # survive next to the replacement and read "PlayerA::".
        relabel(im, (x-2, y-2, x+w+9, y+h+2), alias(tok).rstrip(':') + ':')
        done_overlap(x-6, y-4, x+w+13, y+h+4)
        n += 1

    found = []
    for r in REGIONS:
        found += scan(im, (r[0], r[1], min(r[2], im.width), min(r[3], im.height)))
    found += scan(im)                     # whole image, for the battle log

    # Several passes see the same word, and a second mask laid over the first
    # leaves doubled punctuation and half-erased handles. Merge overlapping
    # boxes and paint each one exactly once.
    cand = []
    for tok, x, y, w, h in found:
        if w < 8 or h < 6: continue
        if SUBTITLE[0] <= x <= SUBTITLE[2] and SUBTITLE[1] <= y <= SUBTITLE[3]: continue
        if chat_blur and x >= chat_blur[0]-40 and y >= chat_blur[1]-10: continue
        cand.append([tok, x-3, y-2, x+w+3, y+h+2])   # pad: OCR clips edge glyphs

    merged = []
    for c in sorted(cand, key=lambda b: (b[2], b[1])):
        for m in merged:
            if not (c[1] > m[3] or c[3] < m[1] or c[2] > m[4] or c[4] < m[2]):
                m[1] = min(m[1], c[1]); m[2] = min(m[2], c[2])
                m[3] = max(m[3], c[3]); m[4] = max(m[4], c[4])
                break
        else:
            merged.append(list(c))
    for tok, x0, y0, x1, y1 in merged:
        if done_overlap(x0, y0, x1, y1): continue
        relabel(im, (max(x0, 0), max(y0, 0), min(x1, im.width), min(y1, im.height)), alias(tok))
        n += 1

    # Sweep: OCR boxes sometimes start mid-word, leaving a fragment beside the
    # replacement ("725PlayerA"). Anything still matching gets erased to the
    # background — the alias is already on the line, so no text is needed.
    for tok, x, y, w, h in scan(im):
        if w < 4 or h < 5: continue
        if chat_blur and x >= chat_blur[0]-40 and y >= chat_blur[1]-10: continue
        box = (max(x-3,0), max(y-2,0), min(x+w+3, im.width), min(y+h+2, im.height))
        ImageDraw.Draw(im).rectangle(box, fill=ring_bg(im, box))

    out = os.path.join(out_dir, os.path.basename(path))
    fit(im).save(out)
    print(f'{out}  ({n} handles replaced)')

if __name__ == '__main__':
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    for p in sys.argv[2:]:
        process(p, out_dir)
