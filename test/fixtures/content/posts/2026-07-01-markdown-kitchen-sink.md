---
title: "Markdown kitchen sink"
date: 2026-07-01
description: "Exercises every Markdown feature the renderer supports."
tags: [markdown, testing]
---

Inline math $E = mc^2$ sits in a sentence, and display math follows:

$$\int_0^1 x\,dx = \tfrac12$$

## Heading level two

Text with *emphasis*, **strong**, `inline code`, and "typographer quotes".

### Heading level three

```python
def greet(name: str) -> str:
    return f"hello {name}"
```

```javascript
const greet = (name) => `hello ${name}`;
```

#### Heading level four

| Column A | Column B |
| --- | --- |
| one | two |

![A diagram](/images/diagram.png)

An [external link](https://example.com/page) and an [internal link](/welcome/).

> A blockquote for good measure.
