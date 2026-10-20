# Everyday eval results

- Date: 2026-10-20
- Model: gemma-4-e2b-it-web (the default chat model)
- Commit: c2a4878 + uncommitted fix helpers

| model | app | drawing | music | facts | math | chat | total | errors | fixes | corr. | mean s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-4-e2b-it-web | 3/4 | 3/4 | 4/4 | 4/4 | 3/4 | 3/4 | 20/24 | 7 | 4 | 1 | 6.8 |

Failed:
- gemma-4-e2b-it-web / app-todo: error in the final program
- gemma-4-e2b-it-web / draw-snake: error in the final program
- gemma-4-e2b-it-web / math-fahrenheit: spoken answer lacks 22.2
- gemma-4-e2b-it-web / chat-joke: error in the final program
