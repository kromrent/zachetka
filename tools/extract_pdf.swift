import Foundation
import PDFKit

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: extract_pdf.swift <file.pdf>\n", stderr)
    exit(2)
}

let source = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: source) else {
    fputs("Cannot open PDF: \(source.path)\n", stderr)
    exit(1)
}

print("[[PAGES:\(document.pageCount)]]")
for index in 0..<document.pageCount {
    print("\n[[PAGE:\(index + 1)]]")
    print(document.page(at: index)?.string ?? "")
}
