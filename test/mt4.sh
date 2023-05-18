#!/bin/bash
cd "$(dirname "$0")"

cd ./adhoc

node ../../bin/geml.js build -c test.default.json --verbose