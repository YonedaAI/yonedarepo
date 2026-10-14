# Task board starter

An empty static app scaffold. No tasks, stored history, previous results or finished implementation are included.

Implement task records `{id,title,completed}` in `public/tasks.mjs`. The public functions are `addTask(tasks,title,id)`, `completeTask(tasks,id)` and `visibleTasks(tasks,options)`. Return arrays of records; supplied IDs identify tasks. `options.query` searches titles case-insensitively; omitted query returns source order.

Build the interface in `public/index.html`, `public/app.mjs` and `public/style.css`. Serve `public` as static files. Behavioral acceptance lives outside candidate source in an owner-approved immutable test bundle.
