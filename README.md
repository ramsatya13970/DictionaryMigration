# DictionaryMigration
flowchart LR

    subgraph MP["LIBRARY | MP | DICTIONARY"]
        direction TB
        T1["title : Welcome"]
        T2["description : Shop Now"]
        T3["ctaLabel : Buy Today"]
    end

    subgraph CONST["LIBRARY | CONSTANTS DICTIONARY"]
        direction TB
        C1["Entry 1<br/>key: title<br/>value: Welcome<br/>internal name: constants | title"]
        C2["Entry 2<br/>key: description<br/>value: Shop Now<br/>internal name: constants | description"]
        C3["Entry 3<br/>key: ctaLabel<br/>value: Buy Today<br/>internal name: constants | ctaLabel"]
    end

    T1 --> C1
    T2 --> C2
    T3 --> C3

  