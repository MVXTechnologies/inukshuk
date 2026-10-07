import Foundation

setvbuf(stdout, nil, _IONBF, 0)
let rounds = CommandLine.arguments.dropFirst().first.flatMap { Int($0) } ?? 400
runProtocolTests(rounds: rounds)
runEngineTests()
