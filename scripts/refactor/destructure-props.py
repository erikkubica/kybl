#!/usr/bin/env python3
# A component made by extract-jsx takes its props destructured: ({ a, b }: Props), and `s.a` is `a`.
import re, sys
p, name = sys.argv[1], sys.argv[2]
s = open(p).read()
m = re.search(rf"export function {name}\((\w+): {name}Props\)", s)
if m:
    v = m.group(1)
    iface = re.search(rf"export interface {name}Props \{{(.*?)\n\}}", s, re.S).group(1)
    keys = re.findall(r"^  (\w+)[?]?:", iface, re.M)
    s = s.replace(m.group(0), f"export function {name}({{ {', '.join(keys)} }}: {name}Props)")
    s = re.sub(rf"(?<![\w.]){v}\.({'|'.join(keys)})\b", r"\1", s)
open(p, "w").write(s)
