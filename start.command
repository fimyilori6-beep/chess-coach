#!/bin/bash
cd "$(dirname "$0")"
(sleep 1 && open http://localhost:3300) &
python3 -m http.server 3300
