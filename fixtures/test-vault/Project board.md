# Project board

Every note tagged #project, sorted by due date. Edit a project's properties (right panel → Properties) and this table updates.

```table
from: #project
sort: due
columns: file, status, due, priority
```

Open work only:

```table
from: #project
where: status != done
sort: priority
columns: file, status, priority
```
