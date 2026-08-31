#!/usr/bin/env python3
"""
Render PRIVACY.md into a standalone privacy.html.

The Chrome Web Store listing needs a public URL for the policy. This produces
one self-contained file — no webfonts, no CDN, no analytics, which would be a
poor look on a privacy policy — that can be dropped on GitHub Pages, a Gist,
or anywhere else.

    python3 scripts/build-privacy-page.py PRIVACY.md docs/privacy.html
"""
import sys, re, markdown

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Randbats Live</title>
<meta name="description" content="Randbats Live collects nothing. What it stores, what leaves your browser, and why.">
<style>
  :root {{
    --ground:#f6f7f9; --surface:#fff; --hair:#dde2ea; --ink:#14181e;
    --dim:#4a5462; --signal:#1d47c9; --sunken:#eef1f5;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --ground:#0f1218; --surface:#171b23; --hair:#2a303b; --ink:#eef1f6;
      --dim:#a3adbd; --signal:#7fb2ff; --sunken:#1e232c;
    }}
  }}
  * {{ box-sizing:border-box; }}
  body {{
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }}
  main {{ max-width:46rem; margin:0 auto; padding:56px 24px 96px; }}
  h1 {{ font-size:clamp(28px,5vw,40px); line-height:1.15; letter-spacing:-.02em; margin:0 0 8px; text-wrap:balance; }}
  h2 {{ font-size:22px; letter-spacing:-.01em; margin:44px 0 10px; text-wrap:balance; }}
  h3 {{ font-size:17px; margin:28px 0 8px; }}
  p, li {{ color:var(--ink); }}
  em {{ color:var(--dim); font-style:normal; }}
  a {{ color:var(--signal); text-underline-offset:2px; }}
  code {{
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.88em;
    background:var(--sunken); border:1px solid var(--hair); border-radius:4px; padding:1px 5px;
  }}
  table {{ width:100%; border-collapse:collapse; margin:18px 0; font-size:14.5px; display:block; overflow-x:auto; }}
  th, td {{ text-align:left; padding:10px 12px; border-bottom:1px solid var(--hair); vertical-align:top; }}
  th {{ font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); font-weight:600; }}
  blockquote {{ margin:18px 0; padding:12px 16px; border-left:2px solid var(--signal); background:var(--sunken); border-radius:0 6px 6px 0; }}
  blockquote p {{ margin:0; }}
  hr {{ border:0; border-top:1px solid var(--hair); margin:40px 0; }}
  strong {{ font-weight:600; }}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>
"""

def main(src, out):
    md = open(src, encoding='utf-8').read()
    html = markdown.markdown(md, extensions=['tables', 'sane_lists'])
    # The "_Last updated_" line reads better as muted text than as emphasis.
    html = re.sub(r'<p><em>(Last updated[^<]*)</em></p>', r'<p><em>\1</em></p>', html)
    open(out, 'w', encoding='utf-8').write(TEMPLATE.format(body=html))
    print(out, len(open(out, encoding='utf-8').read()), 'bytes')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'PRIVACY.md',
         sys.argv[2] if len(sys.argv) > 2 else 'docs/privacy.html')
