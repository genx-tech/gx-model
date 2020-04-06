#!/bin/sh

./node_modules/.bin/jison ./src/lang/grammar/geml.jison -o ./src/lang/grammar/geml.js 

cp ./src/lang/grammar/geml.jison ./geml-grammar-debugger/public/geml.jison

npm run build