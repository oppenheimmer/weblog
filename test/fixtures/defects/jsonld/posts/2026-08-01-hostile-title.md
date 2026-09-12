---
title: 'Breaking out </script><img src=x onerror=alert(1)> of "JSON-LD" & it''s ]]> friends'
date: 2026-08-01
description: 'A description that closes </script> early, with & < > " and it''s apostrophe.'
tags: [security, 'tag & <danger>']
---

The title and description above must survive serialization into JSON-LD, Open
Graph attributes, RSS and the sitemap intact. Every one of those is a different
escaping context reached from the same metadata.
